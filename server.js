const express = require('express');
const compression = require('compression');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { LRUCache } = require('lru-cache');

const app = express();

app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.static('public', { maxAge: '1d', etag: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const cache = new LRUCache({
  max: 200,
  ttl: 1000 * 60 * 10,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (value) => {
    return value.body.length;
  }
});

// Blocked domains that won't work
const BLOCKED_DOMAINS = [
  'chatgpt.com',
  'openai.com',
  'claude.ai',
  'bard.google.com',
  'bing.com',
  'netflix.com',
  'hulu.com',
  'disney.com',
  'accounts.google.com'
];

function isBlocked(url) {
  try {
    const domain = new URL(url).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some(blocked => domain.includes(blocked));
  } catch {
    return false;
  }
}

app.use('/proxy/*', async (req, res) => {
  try {
    let targetUrl = req.path.replace('/proxy/', '');
    targetUrl = decodeURIComponent(targetUrl);

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // Check if blocked
    if (isBlocked(targetUrl)) {
      return res.status(403).send(`
        <html>
          <head>
            <style>
              body{background:#0a0a0a;color:#fff;font-family:Arial;padding:40px;text-align:center}
              h1{color:#f44}
              .error{background:rgba(255,68,68,0.1);border:1px solid #f44;border-radius:8px;padding:20px;margin-top:20px;max-width:600px;margin-left:auto;margin-right:auto}
              a{color:#4a9eff;text-decoration:none}
            </style>
          </head>
          <body>
            <h1>Site Blocked</h1>
            <div class="error">
              <p><strong>This site cannot be proxied</strong></p>
              <p>Sites like ChatGPT, Claude, and streaming services have protection against proxies.</p>
              <p style="margin-top:20px;"><a href="/" onclick="parent.showHome(); return false;">← Go Home</a></p>
            </div>
          </body>
        </html>
      `);
    }

    console.log('Proxying:', targetUrl);

    const cacheKey = targetUrl;
    const cached = cache.get(cacheKey);
    if (cached && req.method === 'GET') {
      Object.keys(cached.headers).forEach(key => {
        res.set(key, cached.headers[key]);
      });
      res.set('X-Cache', 'HIT');
      return res.send(cached.body);
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const baseUrl = new URL(targetUrl);

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      if (!['content-security-policy', 'x-frame-options', 'content-security-policy-report-only', 'strict-transport-security'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['Access-Control-Allow-Methods'] = '*';
    responseHeaders['Access-Control-Allow-Headers'] = '*';
    responseHeaders['X-Frame-Options'] = 'ALLOWALL';
    responseHeaders['X-Cache'] = 'MISS';

    Object.keys(responseHeaders).forEach(key => {
      res.set(key, responseHeaders[key]);
    });

    if (contentType.includes('text/html')) {
      let html = await response.text();
      
      html = html.replace(/<meta[^>]*http-equiv=["']?(Content-Security-Policy|X-Frame-Options)["']?[^>]*>/gi, '');
      
      const $ = cheerio.load(html, { decodeEntities: false });

      const rewriteUrl = (url) => {
        if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('/proxy/')) {
          return url;
        }
        try {
          const absolute = new URL(url, baseUrl).href;
          return '/proxy/' + encodeURIComponent(absolute);
        } catch {
          return url;
        }
      };

      $('a[href], link[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) $(el).attr('href', rewriteUrl(href));
      });

      $('script[src], img[src], iframe[src], embed[src], source[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) $(el).attr('src', rewriteUrl(src));
      });

      $('form[action]').each((i, el) => {
        const action = $(el).attr('action');
        if (action) $(el).attr('action', rewriteUrl(action));
      });

      if (!$('base').length) {
        $('head').prepend(`<base href="${baseUrl.origin}/">`);
      }

      const proxyScript = `
        <script>
          (function() {
            const proxyPrefix = '/proxy/';
            const baseHref = '${baseUrl.href}';
            
            function proxyUrl(url) {
              if (!url || typeof url !== 'string') return url;
              if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith(proxyPrefix)) {
                return url;
              }
              try {
                const absolute = new URL(url, baseHref).href;
                return proxyPrefix + encodeURIComponent(absolute);
              } catch {
                return url;
              }
            }

            const originalXHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              return originalXHROpen.call(this, method, proxyUrl(url), ...rest);
            };

            const originalFetch = window.fetch;
            window.fetch = function(url, options = {}) {
              if (typeof url === 'string') {
                url = proxyUrl(url);
              }
              return originalFetch.call(this, url, options);
            };

            const originalOpen = window.open;
            window.open = function(url, ...rest) {
              if (url) url = proxyUrl(url);
              return originalOpen.call(this, url, ...rest);
            };

            console.log('Proxy active');
          })();
        </script>
      `;

      html = html.replace('</head>', proxyScript + '</head>');
      if (!html.includes('</head>')) {
        html = html.replace('<body', proxyScript + '<body');
      }

      html = $.html();

      cache.set(cacheKey, { body: html, headers: responseHeaders });
      res.send(html);
    }
    else if (contentType.includes('text/css')) {
      let css = await response.text();
      
      css = css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (match, url) => {
        if (url.startsWith('data:')) return match;
        try {
          const absolute = new URL(url, baseUrl).href;
          return `url('/proxy/${encodeURIComponent(absolute)}')`;
        } catch {
          return match;
        }
      });

      cache.set(cacheKey, { body: css, headers: responseHeaders });
      res.send(css);
    }
    else {
      const buffer = await response.buffer();
      
      if (buffer.length < 5 * 1024 * 1024) {
        cache.set(cacheKey, { body: buffer, headers: responseHeaders });
      }
      
      res.send(buffer);
    }

  } catch (error) {
    console.error('Proxy error:', error.message);
    
    let errorMsg = error.message;
    if (error.message.includes('403')) {
      errorMsg = 'Site is blocking proxy access (403 Forbidden)';
    } else if (error.message.includes('aborted')) {
      errorMsg = 'Request timed out - site took too long to respond';
    }

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
            <p><code>${errorMsg}</code></p>
            <p style="margin-top:20px;">Some sites block proxies. Try a different site.</p>
            <p style="margin-top:20px;"><a href="/" onclick="parent.showHome(); return false;">← Go Home</a></p>
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
app.listen(PORT, () => console.log(`redio running on ${PORT}`));