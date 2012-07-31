# detectfeed

Detect RSS/Atom feed for an URL

## Install

Install with npm

    npm install detectfeed

## Usage

Use *detectFeedUrl()* for discovering the RSS/Atom feed for an URL

    var detectFeedUrl = require("detectfeed").detectFeedUrl;

    detectFeedUrl("http://techcrunch.com", function(error, info){
        console.log(info);
    });

Outputs

    {
        url: 'http://techcrunch.com/',
        feed: 'http://techcrunch.com/feed/',
        type: 'wordpress',
        icon: {
            url: "http://techcrunch.com/favicon.ico",
            contentType: "image/x-icon"
        }
    }

## License

**MIT**