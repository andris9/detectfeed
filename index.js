var fetch = require("fetch"),
    urllib = require("url");

module.exports.detectFeedUrl = detectFeedUrl;

var domainRoute = [
    [/^([^\.]+\.blogspot\.com)$/i, "blogspot"],
    [/^([^\.]+\.wordpress\.com)$/i, "wordpress"],
    [/^([^\.]+\.livejournal\.com)$/i, "livejournal"],
    [/^([^\.]+\.tumblr\.com)$/i, "tumblr"],
    [/^([^\.]+\.typepad\.com)$/i, "movabletype"]
]

var autoRoute = {
        blogspot: "feeds/posts/default",
        wordpress: "?feed=rss",
        livejournal: "data/rss",
        tumblr: "rss",
        movabletype: "atom.xml"
    },

    commentsRoute = {
        blogspot: function(url){return url.replace(/\/posts\//, "/comments/");},
        wordpress: function(url){return url.replace(/\=rss\d?\b/, "=comments-rss2");},
        movabletype: function(url){return "comments.xml";}
    };

function detectFeedUrl(blogUrl, options, callback){
    if(!callback && typeof options == "function"){
        callback = options;
        options = undefined;
    }
    options = options || {};
    fetch.fetchUrl(blogUrl, {
        timeout: 3000,
        maxResponseLength: 1024 * 1024 * 2
    }, function(error, meta, body){
        if(error){
            return callback(error);
        }

        if(meta.status != 200){
            return callback(new Error("Invalid status "+meta.status));
        }

        blogUrl = urllib.format(urllib.parse(meta.finalUrl));

        fetchIconURLFromHTML(blogUrl, body, function(error, iconData){
            checkSignatures(blogUrl, meta, body, function(error, data){
                if(error){
                    return callback(error);
                }

                if(!data){
                    data = {
                        url: blogUrl,
                        type: "other",
                        feed: fetchFeedURLFromHTML(blogUrl, body)
                    }
                }

                data.icon = iconData;

                checkCommentsFeed(data, body, options, function(err, data){

                    if(!data.feed){
                        return callback(null, data);
                    }

                    fetch.fetchUrl(data.feed, {
                            method:"HEAD",
                            timeout: 3000
                        }, function(error, meta, body){
                            if(error){
                                return callback(error);
                            }

                            if(meta.status != 200){
                                data.feed = null;
                            }else{
                                data.feed = meta.finalUrl;
                            }

                            return callback(null, data);
                        });
                });
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
            checkWordpressSignature,
            checkMovabletypeSignature
        ],
        ready = false,
        waitingFor = signatureCheckers.length;

    if(blogType = checkDomains(parts.hostname)){
        feedUrl = formatFeedUrl(blogUrl, blogType);

        return callback(null, {
            url: blogUrl,
            feed: feedUrl,
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
                        url: blogUrl,
                        feed: feedUrl,
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

function fetchIconURLFromHTML(url, body, callback){
    var links = parseLinkElements(body),
        iconUrls = [],
        contentType;
    
    for(var i=0, len = links.length; i<len; i++){
        if((links[i].rel || "").match(/\bicon\b/i)){
            iconUrls.push(urllib.resolve(url, links[i].href));
        }
    }
    iconUrls.push(urllib.resolve(url, "/favicon.ico"));

    function checkIcon(){
        if(!iconUrls.length){
            return callback(null, null);
        }
        var iconUrl = iconUrls.shift();

        fetch.fetchUrl(iconUrl, {
                maxResponseLength: 1024 * 512,
                method: "HEAD",
                timeout: 3000
            }, function(error, meta, body){
                contentType = meta.responseHeaders['content-type'];
                if(contentType.match(/\bicon?$/)){
                    contentType = "image/x-icon";
                }

                if(error || meta.status != 200 || ["image/png", "image/jpeg", "image/gif", "image/x-icon"].indexOf(contentType)<0){
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

function fetchFeedURLFromHTML(url, body){
    var links = parseLinkElements(body),
        feedUrls = [];
    for(var i=0, len = links.length; i<len; i++){
        if(
          (links[i].rel || "").toLowerCase() == "alternate" && 
          ["application/rss+xml", "application/atom+xml"].indexOf((links[i].type || "").toLowerCase()) >= 0){
            feedUrls.push(urllib.resolve(url, links[i].href));
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

    if(meta.responseHeaders.server && meta.responseHeaders.server.match(/\bGSE\b/)){
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

function checkCommentsFeed(data, body, options, callback){
    data = data || {};
    
    var comments, disqus;

    if(typeof commentsRoute[data.type] == "function"){
        comments = commentsRoute[data.type](data.feed);
    }

    if(options.disqus_api_key && (disqus = checkDisqusUsername(body))){
        comments = "https://disqus.com/api/3.0/posts/list.rss?forum="+disqus+"&api_key="+options.disqus_api_key;
    }

    if(comments){
        fetch.fetchUrl(comments, {
            maxResponseLength: 1024,
            method: "HEAD",
            timeout: 3000
        }, function(error, meta, body){

            if(error || meta.status != 200){
                return callback(null, data);
            }

            if(meta.finalUrl != data.feed){
                data.comments = meta.finalUrl;
                if(options.disqus_api_key){
                    data.comments = data.comments.replace(options.disqus_api_key, "DISQUS_API_KEY");
                }    
            }
            
            return callback(null, data);
        });
    }else{
        callback(null, data);
    }
    
}

function checkDisqusUsername(html){
    var match;

    html = (html || "").toString("utf-8");

    if((match = html.match(/\bdisqus_shortname\s*=\s*['"](\w+)['"]/))){
        return match[1];
    }

    if((match = html.match(/<meta\s+name\s*=\s*["']text:Disqus Shortname["']\s+content\s*=\s*["'](\w+)["']/))){
        return match[1];
    }

    if((match = html.match(/http:\/\/disqus.com\/forums\/(\w+)\/get_num_replies.js/))){
        return match[1];
    }

    return false;
}

function checkMovabletypeSignature(url, meta, body, callback){
    var parts = urllib.parse(url),
        blogType = "movabletype",
        feedUrl = formatFeedUrl(url, blogType),
        match;

    fetch.fetchUrl(feedUrl, {
            maxResponseLength: 1024 * 512,
            timeout: 3000
        }, function(error, meta, body){
            if(error){
                return callback(null);
            }

            if(meta.status == 200){
                if((match = (body || "").toString().match(/<generator[^>]*>([^<]*)<\/generator[^>]*>/i))){
                    if(match[1].match(/typepad/i) || match[1].match(/movable type/i)){
                        return callback(null, blogType, meta.finalUrl);
                    }
                }
            }

            return callback(null);
        });
};
