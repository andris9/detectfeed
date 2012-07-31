var fetch = require("fetch"),
    urllib = require("url");

module.exports.detectFeedUrl = detectFeedUrl;

var domainRoute = [
    [/^([^\.]+\.blogspot\.com)$/i, "blogspot"],
    [/^([^\.]+\.wordpress\.com)$/i, "wordpress"],
    [/^([^\.]+\.livejournal\.com)$/i, "livejournal"],
    [/^([^\.]+\.tumblr\.com)$/i, "tumblr"]
]

var autoRoute = {
    blogspot: "feeds/posts/default",
    wordpress: "?feed=rss",
    livejournal: "data/rss",
    tumblr: "rss"
};

function detectFeedUrl(blogUrl, callback){
    fetch.fetchUrl(blogUrl, {
        timeout: 3000,
        maxResponseLength: 1024 * 512
    }, function(error, meta, body){
        if(error){
            return callback(error);
        }

        if(meta.status != 200){
            return callback(new Error("Invalid status "+meta.status));
        }

        blogUrl = urllib.format(urllib.parse(meta.finalUrl));
        checkSignatures(blogUrl, meta, body, function(error, data){
            if(error){
                return callback(error);
            }

            if(!data){
                data = {
                    blogUrl: blogUrl,
                    type: "other",
                    feedUrl: fetchFeedURLFromHTML(blogUrl, body)
                }
            }

            if(!data.feedUrl){
                return callback(null, data);
            }

            fetch.fetchUrl(data.feedUrl, {
                    method:"HEAD",
                    timeout: 3000
                }, function(error, meta, body){
                    if(error){
                        return callback(error);
                    }

                    if(meta.status != 200){
                        data.feedUrl = null;
                    }else{
                        data.feedUrl = meta.finalUrl;
                    }

                    return callback(null, data);
                });
        });
    });
}

function checkSignatures(blogUrl, meta, body, callback){
    var parts = urllib.parse(blogUrl),
        blogType, feedUrl,
        signatureCheckers = [
            checkTumblrSignature,
            checkBlogspotSignature,
            checkWordpressSignature
        ],
        ready = false,
        waitingFor = signatureCheckers.length;

    if(blogType = checkDomains(parts.hostname)){
        feedUrl = formatFeedUrl(blogUrl, blogType);

        return callback(null, {
            blogUrl: blogUrl,
            feedUrl: feedUrl,
            type: blogType
        });

    }else{

        for(var i=0, len = signatureCheckers.length; i<len; i++){
            signatureCheckers[i](blogUrl, meta, body, function(error, blogType, feedUrl){
                waitingFor--;

                if(ready){
                    return;
                }

                if(blogType){
                    ready = true;
                    return callback(null, {
                        blogUrl: blogUrl,
                        feedUrl: feedUrl,
                        type: blogType
                    });
                }

                if(!waitingFor){
                    return callback(null);
                }
            });
        }

    }

}

function fetchFeedURLFromHTML(url, body){
    var links = parseLinkElements(body),
        feedUrls = [];
    for(var i=0, len = links.length; i<len; i++){
        if(
          (links[i].rel || "").toLowerCase() == "alternate" && 
          ["application/rss+xml", "application/atom+xml"].indexOf((links[i].type || "").toLowerCase()) >= 0){
            feedUrls.push(links[i].href);
        }
    }

    feedUrls.sort(function(a, b){
        return a.length - b.length;
    });

    return feedUrls[0] || null;
}

function parseLinkElements(body){
    var links = [];
    (body || "").toString().replace(/\r?\n/g, "\u0000").replace(/<link[^>]+>/ig, function(link){
        var params = {};
        link.replace(/\b([\w\-]+)\s*=\s*['"]([^'"]+)['"]/g, function(o, key, val){
            params[key.replace(/\u0000/g,"\n").trim()] = val.replace(/\u0000/g,"\n").trim();
        });

        links.push(params);
    });
    return links;
}

function formatFeedUrl(blogUrl, blogType){
    var parts = urllib.parse(blogUrl),
        feedUrl;

    delete parts.search;
    delete parts.query;
    delete parts.href;
    parts.path += autoRoute[blogType];
    parts.pathname += autoRoute[blogType];

    return urllib.format(parts);
}


function checkDomains(domain){
    for(var i=0, len = domainRoute.length; i<len; i++){
        if(domain.match(domainRoute[0])){
            return domainRoute[1];
        }
    }
    return null;
}

function checkTumblrSignature(url, meta, body, callback){
    var blogType, feedUrl;

    if(!!meta.responseHeaders['x-tumblr-user']){
        blogType = "tumblr";
        feedUrl = formatFeedUrl(url, blogType);
    }

    return callback(null, blogType, feedUrl);
}

function checkBlogspotSignature(url, meta, body, callback){
    var blogType, feedUrl;

    if(!!meta.responseHeaders.server.match(/\bGSE\b/)){
        blogType = "blogspot";
        feedUrl = formatFeedUrl(url, blogType);
    }

    return callback(null, blogType, feedUrl);
}

function checkWordpressSignature(url, meta, body, callback){
    var parts = urllib.parse(url),
        blogType = "wordpress",
        feedUrl = formatFeedUrl(url, blogType);

    if(([].concat(meta.responseHeaders.link)[0] || "").match(/\bwp\.me\b/)){
        return callback(null, blogType, feedUrl);
    }

    if((body || "").toString().match(/\bwp\-content\b/)){
        return callback(null, blogType, feedUrl);
    }

    fetch.fetchUrl(feedUrl, {
            maxResponseLength: 1024 * 512,
            timeout: 3000
        }, function(error, meta, body){
            if(error){
                return callback(null);
            }

            if(meta.status == 200){
                if((body || "").toString().match(/\bgenerator\s*=\s*"?wordpress\b/i)){
                    return callback(null, blogType, meta.finalUrl);
                }
            }

            return callback(null);
        });
};