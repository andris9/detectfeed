"use strict";

var fetch = require("fetch"),
    urllib = require("url"),
    NodePie = require("nodepie"),
    guessLanguage = require("guesslanguage").guessLanguage;

module.exports.detectFeedUrl = detectFeedUrl;

var domainRoute = [
    [/^([^\.]+\.blogspot\.com)$/i, "blogspot"],
    [/^([^\.]+\.wordpress\.com)$/i, "wordpress"],
    [/^([^\.]+\.livejournal\.com)$/i, "livejournal"],
    [/^([^\.]+\.tumblr\.com)$/i, "tumblr"],
    [/^([^\.]+\.typepad\.com)$/i, "movabletype"]
];

var autoRoute = {
    blogspot: "feeds/posts/default",
    wordpress: "?feed=rss",
    livejournal: "data/rss",
    tumblr: "rss",
    movabletype: "atom.xml",
    ghost: "rss/",
},

    commentsRoute = {
        blogspot: function(url) {
            return url.replace(/\/posts\//, "/comments/");
        },
        wordpress: function(url) {
            return url.replace(/\=rss\d?\b/, "=comments-rss2");
        },
        movabletype: function() {
            return "comments.xml";
        }
    },

    defaultHub = {
        blogspot: "http://pubsubhubbub.appspot.com/"
    };

function detectFeedUrl(blogUrl, options, level, callback) {
    if (!callback && typeof level == "function") {
        callback = level;
        level = undefined;
    }

    if (!callback && typeof options == "function") {
        callback = options;
        options = undefined;
    }
    level = level || 0;
    options = options ||  {};
    fetch.fetchUrl(blogUrl, {
        timeout: 3000,
        maxResponseLength: 1024 * 1024 * 2,
        agent: false
    }, function(error, meta, body) {
        var nodepie;

        if (error) {
            return callback(error);
        }

        if (meta.status != 200) {
            return callback(new Error("Invalid status " + meta.status));
        }

        if (level < 3) {
            try {
                nodepie = new NodePie(body);
                nodepie.init();
                if (nodepie.getPermalink()) {
                    return detectFeedUrl(nodepie.getPermalink(), options, level + 1, callback);
                }
            } catch (E) {}
        }

        blogUrl = urllib.format(urllib.parse(meta.finalUrl));

        var rel = {};

        (meta.headers && meta.headers.link || "").
        replace(/<([^>]+)>\s*(?:;\s*rel=['"]([^'"]+)['"])?/gi, function(o, url, key) {
            rel[(key ||  "").toLowerCase()] = url;
        });

        fetchIconURLFromHTML(blogUrl, rel.icon, body, function(error, iconData) {
            checkSignatures(blogUrl, meta, body, function(error, data) {
                if (error) {
                    return callback(error);
                }

                if (!data) {
                    data = {
                        url: blogUrl,
                        type: "other",
                        feed: fetchFeedURLFromHTML(blogUrl, body)
                    };
                }

                if (!data.feed) {
                    data.feed = fetchFeedURLFromHTML(blogUrl, body) || data.feed;
                }

                data.icon = iconData;

                checkCommentsFeed(data, body, options, function(err, data) {

                    if (!data.feed) {
                        return callback(null, data);
                    }

                    fetch.fetchUrl(data.feed, {
                        timeout: 3000,
                        disableDecoding: true,
                        maxResponseLength: 3 * 1024 * 1024,
                    }, function(error, meta, body) {
                        var nodepie;

                        if (error) {
                            return callback(error);
                        }

                        if (meta.status != 200) {
                            data.feed = null;
                            return callback(null, data);
                        } else {
                            data.feed = meta.finalUrl;
                            try {
                                nodepie = new NodePie(body);
                                nodepie.init();
                            } catch (E) {
                                data.feed = null;
                                return callback(null, data);
                            }
                            data.url = nodepie.getPermalink() || data.url;
                            data.hub = nodepie.getHub() || defaultHub[data.type];
                            data.title = nodepie.getTitle() || "";
                            data.description = nodepie.getDescription() || "";


                            var langStr = "";
                            nodepie.getItems(0, 3).forEach(function(item) {
                                langStr += ((item.getTitle() || "") + " " + (item.getContents() || "")).
                                replace(/\s+/g, " ").replace(/<[^>]>/g, " ").trim() + " ";
                            });
                            guessLanguage.detect(langStr, function(language) {
                                if (language) {
                                    data.language = language;
                                }
                                return callback(null, data);
                            });
                        }
                    });
                });
            });
        });
    });
}

function checkSignatures(blogUrl, meta, body, callback) {
    var parts = urllib.parse(blogUrl),
        blogType, feedUrl,
        signatureCheckers = [
            checkTumblrSignature,
            checkBlogspotSignature,
            checkWordpressSignature,
            checkMovabletypeSignature,
            checkGhostSignature
        ],
        ready = false,
        waitingFor = signatureCheckers.length;

    if ((blogType = checkDomains(parts.hostname))) {
        feedUrl = formatFeedUrl(blogUrl, blogType);

        return callback(null, {
            url: blogUrl,
            feed: feedUrl,
            type: blogType
        });

    } else {

        if (parts.hostname.match(/medium\.com/)) {
            signatureCheckers.unshift(checkMediumSignature);
            waitingFor++;
        }

        signatureCheckers.forEach(function(signatureChecker) {
            signatureChecker(blogUrl, meta, body, function(error, blogType, feedUrl) {
                waitingFor--;

                if (ready) {
                    return;
                }

                if (blogType) {
                    ready = true;
                    return callback(null, {
                        url: blogUrl,
                        feed: feedUrl,
                        type: blogType
                    });
                }

                if (!waitingFor) {
                    return callback(null);
                }
            });
        });
    }
}

function fetchIconURLFromHTML(url, headerIcon, body, callback) {
    var links = parseLinkElements(body),
        iconUrls = [],
        contentType;

    if (headerIcon) {
        iconUrls.push(urllib.resolve(url, headerIcon));
    }

    for (var i = 0, len = links.length; i < len; i++) {
        if (links[i].href && (links[i].rel || "").match(/\bicon\b/i)) {
            iconUrls.push(urllib.resolve(url, links[i].href));
        }
    }
    iconUrls.push(urllib.resolve(url, "/favicon.ico"));

    function checkIcon() {
        if (!iconUrls.length) {
            return callback(null, null);
        }
        var iconUrl = iconUrls.shift();

        fetch.fetchUrl(iconUrl, {
            maxResponseLength: 1024 * 512,
            method: "HEAD",
            timeout: 3000
        }, function(error, meta) {
            if (!error && meta) {
                contentType = meta.responseHeaders['content-type'] || "";
                if (contentType.match(/\bicon?$/)) {
                    contentType = "image/x-icon";
                }
            } else {
                contentType = "";
            }

            if (error ||  meta.status != 200 || ["image/png", "image/jpeg", "image/gif", "image/x-icon"].indexOf(contentType) < 0) {
                return process.nextTick(checkIcon);
            }

            return callback(null, {
                url: meta.finalUrl,
                contentType: contentType
            });
        });

    }
    checkIcon();
}

function fetchFeedURLFromHTML(url, body) {
    var links = parseLinkElements(body),
        feedUrls = [];
    for (var i = 0, len = links.length; i < len; i++) {
        if (
            (links[i].rel || "").toLowerCase() == "alternate" &&
            ["application/rss+xml", "application/atom+xml"].indexOf((links[i].type || "").toLowerCase()) >= 0) {
            feedUrls.push(urllib.resolve(url, links[i].href));
        }
    }

    feedUrls.sort(function(a, b) {
        return a.length - b.length;
    });

    return feedUrls[0] ||  null;
}

function parseLinkElements(body) {
    var links = [];
    (body || "").toString().replace(/\r?\n/g, "\u0000").replace(/<link[^>]+>/ig, function(link) {
        var params = {};
        link.replace(/\b([\w\-]+)\s*=\s*['"]([^'"]+)['"]/g, function(o, key, val) {
            params[key.replace(/\u0000/g, "\n").trim()] = val.replace(/\u0000/g, "\n").trim();
        });

        links.push(params);
    });
    return links;
}

function formatFeedUrl(blogUrl, blogType) {
    var parts = urllib.parse(blogUrl),
        pathParts = autoRoute[blogType].split("?"),
        pathName = pathParts.shift() || "",
        pathQuery = pathParts.join("?") || "";

    delete parts.search;
    delete parts.query;
    delete parts.href;
    parts.path += pathName;
    parts.pathname += pathName;

    if (pathQuery) {
        parts.path += "?" + pathQuery;
        parts.search = "?" + pathQuery;
        parts.query = pathQuery;
    }

    return urllib.format(parts);
}


function checkDomains(domain) {
    for (var i = 0, len = domainRoute.length; i < len; i++) {
        if (domain.match(domainRoute[i][0])) {
            return domainRoute[i][1];
        }
    }
    return null;
}

function checkMediumSignature(url, meta, body, callback) {
    var parts = urllib.parse(url),
        blogType = "medium",
        feedUrl;

    if (!parts.hostname.match(/^(([^\.]+\.)?medium\.com)$/i)) {
        return callback(null);
    }

    body.toString().replace(/\r?\n|\n/g, "\u0000").replace(/<meta\b[^>]*>/ig, function(meta) {
        var match;
        if (meta.match(/property\s*=\s*["']?article:author/i) && (match = meta.match(/medium.com\/(@[^'"]+)/))) {
            feedUrl = "https://medium.com/feed/" + match[1];
        }
    });

    return callback(null, blogType, feedUrl);
}

function checkTumblrSignature(url, meta, body, callback) {
    var blogType, feedUrl;

    if ( !! meta.responseHeaders['x-tumblr-user']) {
        blogType = "tumblr";
        feedUrl = formatFeedUrl(url, blogType);
    }

    return callback(null, blogType, feedUrl);
}

function checkBlogspotSignature(url, meta, body, callback) {
    var blogType, feedUrl;

    if (meta.responseHeaders.server && meta.responseHeaders.server.match(/\bGSE\b/)) {
        blogType = "blogspot";
        feedUrl = formatFeedUrl(url, blogType);
    }

    return callback(null, blogType, feedUrl);
}

function checkWordpressSignature(url, meta, body, callback) {
    var blogType = "wordpress",
        feedUrl = formatFeedUrl(url, blogType);

    if (([].concat(meta.responseHeaders.link)[0] || "").match(/\bwp\.me\b/)) {
        return callback(null, blogType, feedUrl);
    }

    if ((body || "").toString().match(/\bwp\-content\b/)) {
        return callback(null, blogType, feedUrl);
    }

    fetch.fetchUrl(feedUrl, {
        maxResponseLength: 1024 * 512,
        timeout: 3000
    }, function(error, meta, body) {
        if (error) {
            return callback(null);
        }

        if (meta.status == 200) {
            if ((body || "").toString().match(/\bgenerator\s*=\s*"?wordpress\b/i)) {
                return callback(null, blogType, meta.finalUrl);
            }
        }

        return callback(null);
    });
}

function checkGhostSignature(url, meta, body, callback) {
    var blogType,
        feedUrl;

    body.toString().replace(/\r?\n|\n/g, "\u0000").replace(/<meta\b[^>]*>/ig, function(meta) {
        if (meta.match(/name\s*=\s*["']?generator/i) && meta.match(/content\s*=\s*["']?\s*ghost/i)) {
            blogType = "ghost";
            feedUrl = formatFeedUrl(url, blogType);
        }
    });

    if (!feedUrl) {
        return callback(null);
    }

    fetch.fetchUrl(feedUrl, {
        maxResponseLength: 1024 * 512,
        timeout: 3000
    }, function(error, meta, body) {
        if (error) {
            return callback(null);
        }

        if (meta.status == 200) {
            if ((body || "").toString().match(/\bgenerator\b[^>]*>\s*ghost\b/i)) {
                return callback(null, blogType, meta.finalUrl);
            }
        }

        return callback(null);
    });
}

function checkCommentsFeed(data, body, options, callback) {
    data = data || {};

    var comments, disqus;

    if (typeof commentsRoute[data.type] == "function") {
        comments = commentsRoute[data.type](data.feed);
    }

    if (options.disqus_api_key && (disqus = checkDisqusUsername(body))) {
        comments = "https://disqus.com/api/3.0/posts/list.rss?forum=" + disqus + "&api_key=" + options.disqus_api_key;
    }

    if (comments) {
        fetch.fetchUrl(comments, {
            maxResponseLength: 1024,
            method: "HEAD",
            timeout: 3000
        }, function(error, meta) {

            if (error ||  meta.status != 200) {
                return callback(null, data);
            }

            if (meta.finalUrl != data.feed) {
                data.comments = meta.finalUrl;
                if (options.disqus_api_key) {
                    data.comments = data.comments.replace(options.disqus_api_key, "DISQUS_API_KEY");
                }
            }

            return callback(null, data);
        });
    } else {
        callback(null, data);
    }

}

function checkDisqusUsername(html) {
    var match;

    html = (html || "").toString("utf-8");

    if ((match = html.match(/\bdisqus_shortname\s*=\s*['"](\w+)['"]/))) {
        return match[1];
    }

    if ((match = html.match(/<meta\s+name\s*=\s*["']text:Disqus Shortname["']\s+content\s*=\s*["'](\w+)["']/))) {
        return match[1];
    }

    if ((match = html.match(/http:\/\/disqus.com\/forums\/(\w+)\/get_num_replies.js/))) {
        return match[1];
    }

    return false;
}

function checkMovabletypeSignature(url, meta, body, callback) {
    var blogType = "movabletype",
        feedUrl = formatFeedUrl(url, blogType),
        match;

    fetch.fetchUrl(feedUrl, {
        maxResponseLength: 1024 * 512,
        timeout: 3000
    }, function(error, meta, body) {
        if (error) {
            return callback(null);
        }

        if (meta.status == 200) {
            if ((match = (body || "").toString().match(/<generator[^>]*>([^<]*)<\/generator[^>]*>/i))) {
                if (match[1].match(/typepad/i) || match[1].match(/movable type/i)) {
                    return callback(null, blogType, meta.finalUrl);
                }
            }
        }

        return callback(null);
    });
}
