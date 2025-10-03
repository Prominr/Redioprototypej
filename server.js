const express = require('express');
const compression = require('compression');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { LRUCache } = require('lru-cache');

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
    // Extract and validate URL
    let targetUrl = req.originalUrl.replace('/proxy/', '');
    
    // Remove any leading slash that might remain
    if (targetUrl.startsWith('/')) {
      targetUrl = targetUrl.substring(1);
    }
    
    targetUrl = decodeURIComponent(targetUrl);

    // Validate URL format
    if (!targetUrl) {
      throw new Error('Empty URL provided');
    }

    // Add https if not present
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    console.log('Proxying:', targetUrl);

    // Validate URL structure
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (urlError) {
      throw new Error(`Invalid URL: ${targetUrl}`);
    }

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
      'Referer': parsedUrl.origin,
      'Origin': parsedUrl.origin,
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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

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
          const absolute = new URL(url, parsedUrl).href;
          return '/proxy/' + encodeURIComponent(absolute);
        } catch (e) {
          console.log('Failed to rewrite URL:', url, e.message);
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

      // Rewrite form actions
      $('form[action]').each((i, el) => {
        const action = $(el).attr('action');
        if (action) $(el).attr('action', rewriteUrl(action));
      });

      // Add base tag
      if (!$('base').length) {
        $('head').prepend(`<base href="${parsedUrl.origin}/">`);
      }

      // Inject proxy script (your existing script code remains the same)
      const proxyScript = `
        <script>
          // ... your existing proxy script code ...
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
          const absolute = new URL(url, parsedUrl).href;
          return `url('/proxy/${encodeURIComponent(absolute)}')`;
        } catch (e) {
          return match;
        }
      });

      cache.set(cacheKey, { body: css, headers: responseHeaders });
      res.send(css);
    }
    else {
      // Handle other content types (javascript, binary, etc.)
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
