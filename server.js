const express = require('express');
const compression = require('compression');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { createServer } = require('http');
const WebSocket = require('ws');
const { URL } = require('url');

const app = express();
const server = createServer(app);
const wss = new WebSocket.Server({ server });

app.use(compression());
app.use(express.static('public'));

// Simple cache
const cache = new Map();

// WebSocket proxy for games
wss.on('connection', (ws, req) => {
  const targetUrl = req.url.replace('/ws/', '');
  if (!targetUrl) return ws.close();

  try {
    const target = new WebSocket(targetUrl);
    
    target.on('open', () => {
      console.log('WebSocket connected:', targetUrl);
    });

    target.on('message', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    ws.on('message', (data) => {
      if (target.readyState === WebSocket.OPEN) {
        target.send(data);
      }
    });

    target.on('close', () => ws.close());
    ws.on('close', () => target.close());
    target.on('error', (err) => {
      console.error('WebSocket error:', err);
      ws.close();
    });
  } catch (err) {
    console.error('WebSocket connection failed:', err);
    ws.close();
  }
});

// Main proxy endpoint
app.get('/p/*', async (req, res) => {
  try {
    let url = req.path.replace('/p/', '');
    url = decodeURIComponent(url);

    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    console.log('Proxying:', url);

    // Check cache
    if (cache.has(url)) {
      const cached = cache.get(url);
      res.set(cached.headers);
      return res.send(cached.body);
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*'
      },
      redirect: 'follow'
    });

    const contentType = response.headers.get('content-type') || '';
    
    // Set headers
    const headers = {};
    response.headers.forEach((value, key) => {
      if (!['content-security-policy', 'x-frame-options'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    });
    headers['Access-Control-Allow-Origin'] = '*';
    headers['X-Frame-Options'] = 'ALLOWALL';
    
    res.set(headers);

    if (contentType.includes('text/html')) {
      let html = await response.text();
      const baseUrl = new URL(url);
      
      // Remove security headers from HTML
      html = html.replace(/<meta[^>]*http-equiv=["']?(Content-Security-Policy|X-Frame-Options)["']?[^>]*>/gi, '');
      
      const $ = cheerio.load(html);

      // Rewrite URLs
      const rewrite = (oldUrl) => {
        if (!oldUrl || oldUrl.startsWith('data:') || oldUrl.startsWith('javascript:') || oldUrl.startsWith('#')) {
          return oldUrl;
        }
        try {
          const absolute = new URL(oldUrl, baseUrl).href;
          return '/p/' + encodeURIComponent(absolute);
        } catch {
          return oldUrl;
        }
      };

      $('a[href], link[href]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) $(el).attr('href', rewrite(href));
      });

      $('script[src], img[src], iframe[src], video[src], audio[src], source[src]').each((i, el) => {
        const src = $(el).attr('src');
        if (src) $(el).attr('src', rewrite(src));
      });

      $('form[action]').each((i, el) => {
        const action = $(el).attr('action');
        if (action) $(el).attr('action', rewrite(action));
      });

      // Inject proxy script
      const proxyScript = `
        <script>
          (function() {
            const baseUrl = '${baseUrl.href}';
            
            function rewriteUrl(url) {
              if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('/p/')) {
                return url;
              }
              try {
                const absolute = new URL(url, baseUrl).href;
                return '/p/' + encodeURIComponent(absolute);
              } catch {
                return url;
              }
            }

            // Override fetch
            const originalFetch = window.fetch;
            window.fetch = function(url, opts) {
              if (typeof url === 'string') {
                url = rewriteUrl(url);
              }
              return originalFetch.call(this, url, opts);
            };

            // Override XMLHttpRequest
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...args) {
              return originalOpen.call(this, method, rewriteUrl(url), ...args);
            };

            // Override WebSocket
            const originalWS = window.WebSocket;
            window.WebSocket = function(url, protocols) {
              if (url.startsWith('ws://') || url.startsWith('wss://')) {
                const wsUrl = '/ws/' + url;
                return new originalWS(wsUrl.replace('ws://', 'ws://').replace('wss://', 'wss://'), protocols);
              }
              return new originalWS(url, protocols);
            };

            // Override window.open
            const originalWindowOpen = window.open;
            window.open = function(url, ...args) {
              if (url) url = rewriteUrl(url);
              return originalWindowOpen.call(this, url, ...args);
            };

            console.log('🚀 Redio proxy active');
          })();
        </script>
      `;

      html = html.replace('</head>', proxyScript + '</head>');
      if (!html.includes('</head>')) {
        html = proxyScript + html;
      }

      html = $.html();
      
      // Cache it
      cache.set(url, { body: html, headers });
      
      res.send(html);
    } else if (contentType.includes('text/css')) {
      let css = await response.text();
      const baseUrl = new URL(url);
      
      // Rewrite CSS URLs
      css = css.replace(/url\(['"]?([^'")\s]+)['"]?\)/gi, (match, cssUrl) => {
        if (cssUrl.startsWith('data:')) return match;
        try {
          const absolute = new URL(cssUrl, baseUrl).href;
          return `url('/p/${encodeURIComponent(absolute)}')`;
        } catch {
          return match;
        }
      });

      cache.set(url, { body: css, headers });
      res.send(css);
    } else {
      // Binary/other content
      const buffer = await response.buffer();
      res.send(buffer);
    }

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send(`
      <html>
        <head>
          <style>
            body{background:#0a0a0a;color:#fff;font-family:Arial;padding:40px;text-align:center}
            h1{color:#f44}
            .error{background:rgba(255,68,68,0.1);border:1px solid #f44;border-radius:8px;padding:20px;max-width:600px;margin:20px auto}
            a{color:#4a9eff;text-decoration:none}
          </style>
        </head>
        <body>
          <h1>Proxy Error</h1>
          <div class="error">
            <p><strong>Failed to load site</strong></p>
            <p>${err.message}</p>
            <p><a href="/">← Go Home</a></p>
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
server.listen(PORT, () => {
  console.log(`🚀 Redio running on ${PORT}`);
  console.log(`📡 WebSocket proxy ready`);
});