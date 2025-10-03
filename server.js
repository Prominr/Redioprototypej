const express = require('express');
const compression = require('compression');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { LRUCache } = require('lru-cache');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

app.use(compression({ level: 9, threshold: 0 }));
app.use(express.static('public', { maxAge: '7d', etag: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const cache = new LRUCache({
  max: 100,
  ttl: 1000 * 60 * 5
});

// Enhanced proxy that handles ALL content types
app.use('/proxy/*', async (req, res) => {
  try {
    let targetUrl = req.path.replace('/proxy/', '');
    targetUrl = decodeURIComponent(targetUrl);

    // Add https if not present
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    console.log('Proxying:', targetUrl);

    // Check cache
    const cacheKey = targetUrl + JSON.stringify(req.query);
    const cached = cache.get(cacheKey);
    if (cached && req.method === 'GET') {
      Object.keys(cached.headers).forEach(key => {
        res.set(key, cached.headers[key]);
      });
      res.set('X-Cache', 'HIT');
      return res.send(cached.body);
    }

    // Fetch with proper headers
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': new URL(targetUrl).origin,
      'Origin': new URL(targetUrl).origin,
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': req.headers['sec-fetch-dest'] || 'document',
      'Sec-Fetch-Mode': req.headers['sec-fetch-mode'] || 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0'
    };

    // Don't include these headers
    delete headers['host'];
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-host'];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    const baseUrl = new URL(targetUrl);

    // Set response headers
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      // Skip security headers that break embedding
      if (!['content-security-policy', 'x-frame-options', 'content-security-policy-report-only'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    // Add CORS headers to allow everything
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['Access-Control-Allow-Methods'] = '*';
    responseHeaders['Access-Control-Allow-Headers'] = '*';
    responseHeaders['X-Cache'] = 'MISS';

    Object.keys(responseHeaders).forEach(key => {
      res.set(key, responseHeaders[key]);
    });

    // Handle different content types
    if (contentType.includes('text/html')) {
      let html = await response.text();
      
      // Remove security headers from meta tags
      html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
      html = html.replace(/<meta[^>]*http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');

      // Advanced URL rewriting
      const $ = cheerio.load(html, { decodeEntities: false });

      // Rewrite all URLs
      const rewriteUrl = (url) => {
        if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('/proxy/')) {
          return url;
        }
        try {
          const absolute = new URL(url, baseUrl).href;
          return '/proxy/' + encodeURIComponent(absolute);
        } catch (e) {
          return url;
        }
      };

      // Rewrite href attributes
      $('a[href], link[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) $(el).attr('href', rewriteUrl(href));
      });

      // Rewrite src attributes
      $('script[src], img[src], iframe[src], embed[src], source[src], track[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) $(el).attr('src', rewriteUrl(src));
      });

      // Rewrite srcset
      $('img[srcset], source[srcset]').each((i, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
          const rewritten = srcset.split(',').map(part => {
            const [url, descriptor] = part.trim().split(/\s+/);
            return rewriteUrl(url) + (descriptor ? ' ' + descriptor : '');
          }).join(', ');
          $(el).attr('srcset', rewritten);
        }
      });

      // Rewrite video/audio sources
      $('video[src], audio[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) $(el).attr('src', rewriteUrl(src));
      });

      // Rewrite form actions
      $('form[action]').each((i, el) => {
        const action = $(el).attr('action');
        if (action) $(el).attr('action', rewriteUrl(action));
      });

      // Rewrite object/embed data
      $('object[data], embed[data]').each((i, el) => {
        const data = $(el).attr('data');
        if (data) $(el).attr('data', rewriteUrl(data));
      });

      // Add base tag
      if (!$('base').length) {
        $('head').prepend(`<base href="${baseUrl.origin}/">`);
      }

      // Inject comprehensive proxy script
      const proxyScript = `
        <script>
          (function() {
            const proxyPrefix = '/proxy/';
            const baseOrigin = '${baseUrl.origin}';
            const baseHref = '${baseUrl.href}';
            
            // Helper to encode URL for proxy
            function proxyUrl(url) {
              if (!url || typeof url !== 'string') return url;
              if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith(proxyPrefix)) {
                return url;
              }
              try {
                const absolute = new URL(url, baseHref).href;
                return proxyPrefix + encodeURIComponent(absolute);
              } catch (e) {
                return url;
              }
            }

            // Override XMLHttpRequest
            const originalXHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              return originalXHROpen.call(this, method, proxyUrl(url), ...rest);
            };

            // Override fetch
            const originalFetch = window.fetch;
            window.fetch = function(url, options = {}) {
              if (typeof url === 'string') {
                url = proxyUrl(url);
              } else if (url instanceof Request) {
                url = new Request(proxyUrl(url.url), url);
              }
              return originalFetch.call(this, url, options);
            };

            // Override WebSocket
            const originalWebSocket = window.WebSocket;
            window.WebSocket = function(url, protocols) {
              // Convert ws:// to http:// for proxy
              if (url.startsWith('ws://') || url.startsWith('wss://')) {
                url = url.replace('ws://', 'http://').replace('wss://', 'https://');
                url = proxyUrl(url);
                url = url.replace('http://', 'ws://').replace('https://', 'wss://');
              }
              return new originalWebSocket(url, protocols);
            };

            // Override window.open
            const originalOpen = window.open;
            window.open = function(url, ...rest) {
              if (url) url = proxyUrl(url);
              return originalOpen.call(this, url, ...rest);
            };

            // Override location setters
            const originalLocationSetter = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href').set;
            Object.defineProperty(window.Location.prototype, 'href', {
              set: function(url) {
                return originalLocationSetter.call(this, proxyUrl(url));
              }
            });

            // Override document.write
            const originalWrite = document.write;
            document.write = function(content) {
              // Rewrite URLs in written content
              content = content.replace(/(src|href)=["']([^"']+)["']/gi, (match, attr, url) => {
                return attr + '="' + proxyUrl(url) + '"';
              });
              return originalWrite.call(this, content);
            };

            // Override setAttribute for dynamic changes
            const originalSetAttribute = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function(name, value) {
              if (['src', 'href', 'action', 'data'].includes(name) && typeof value === 'string') {
                value = proxyUrl(value);
              }
              return originalSetAttribute.call(this, name, value);
            };

            // Handle service workers
            if ('serviceWorker' in navigator) {
              const originalRegister = navigator.serviceWorker.register;
              navigator.serviceWorker.register = function(scriptURL, options) {
                return originalRegister.call(this, proxyUrl(scriptURL), options);
              };
            }

            // Intercept postMessage for cross-origin communication
            const originalPostMessage = window.postMessage;
            window.postMessage = function(message, targetOrigin, ...rest) {
              if (targetOrigin !== '*' && targetOrigin !== '/') {
                targetOrigin = proxyUrl(targetOrigin);
              }
              return originalPostMessage.call(this, message, targetOrigin, ...rest);
            };

            console.log('Redio proxy active');
          })();
        </script>
      `;

      html = html.replace('</head>', proxyScript + '</head>');
      
      // If no </head>, inject at start of body
      if (!html.includes('</head>')) {
        html = html.replace('<body', proxyScript + '<body');
      }

      html = $.html();

      // Cache HTML
      cache.set(cacheKey, { body: html, headers: responseHeaders });

      res.send(html);
    }
    else if (contentType.includes('text/css')) {
      let css = await response.text();
      
      // Rewrite URLs in CSS
      css = css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (match, url) => {
        if (url.startsWith('data:') || url.startsWith('blob:')) return match;
        try {
          const absolute = new URL(url, baseUrl).href;
          return `url('/proxy/${encodeURIComponent(absolute)}')`;
        } catch (e) {
          return match;
        }
      });

      // Rewrite @import
      css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, url) => {
        try {
          const absolute = new URL(url, baseUrl).href;
          return `@import ${quote}/proxy/${encodeURIComponent(absolute)}${quote}`;
        } catch (e) {
          return match;
        }
      });

      cache.set(cacheKey, { body: css, headers: responseHeaders });
      res.send(css);
    }
    else if (contentType.includes('javascript') || contentType.includes('application/json')) {
      const text = await response.text();
      res.send(text);
    }
    else {
      // Binary content (images, videos, fonts, etc)
      const buffer = await response.buffer();
      
      // Cache small files only
      if (buffer.length < 10 * 1024 * 1024) {
        cache.set(cacheKey, { body: buffer, headers: responseHeaders });
      }
      
      res.send(buffer);
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).send(`
      <html>
        <head>
          <style>
            body{background:#0a0a0a;color:#fff;font-family:Arial;padding:40px;text-align:center}
            h1{color:#f44}
            .error{background:rgba(255,68,68,0.1);border:1px solid #f44;border-radius:8px;padding:20px;margin-top:20px;max-width:600px;margin-left:auto;margin-right:auto}
            a{color:#4a9eff;text-decoration:none}
            code{background:#222;padding:2px 6px;border-radius:4px;font-size:12px}
          </style>
        </head>
        <body>
          <h1>Proxy Error</h1>
          <div class="error">
            <p><strong>Failed to load site</strong></p>
            <p><code>${error.message}</code></p>
            <p style="margin-top:20px;"><a href="/">← Go Home</a></p>
          </div>
        </body>
      </html>
    `);
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`redio proxy running on ${PORT}`));