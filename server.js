const express = require('express');
const compression = require('compression');
const { createBareServer } = require('@tomphttp/bare-server-node');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Create bare server for proper proxying (like Interstellar)
const bare = createBareServer('/bare/');

app.use(compression({ level: 6 }));
app.use(express.static('public', { maxAge: '1d' }));
app.use(express.json());

// Serve Ultraviolet static files
app.use('/uv/', express.static(path.join(__dirname, 'public', 'uv')));

// Bare server upgrade handler for WebSockets
server.on('upgrade', (req, socket, head) => {
  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else {
    socket.end();
  }
});

// Bare server request handler
server.on('request', (req, res) => {
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback for any other routes
app.use((req, res) => {
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Redio proxy running on port ${PORT}`);
  console.log(`📡 Bare server running at /bare/`);
});