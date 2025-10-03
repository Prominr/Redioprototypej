const express = require('express');
const compression = require('compression');
const { createServer } = require('http');
const { createBareServer } = require('@tomphttp/bare-server-node');
const path = require('path');

const app = express();
const httpServer = createServer();

// Create bare server
const bare = createBareServer('/bare/');

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));

// Handle bare server requests
httpServer.on('request', (req, res) => {
  if (bare.shouldRoute(req)) {
    bare.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

// Handle websocket upgrades for bare server
httpServer.on('upgrade', (req, socket, head) => {
  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else {
    socket.end();
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Redio running on port ${PORT}`);
  console.log(`📡 Bare server ready at /bare/`);
});