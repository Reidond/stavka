const http = require("http");

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    console.log("\n====== REQUEST ======");
    console.log(`${req.method} ${req.url}`);
    console.log("--- Headers ---");
    for (const [key, value] of Object.entries(req.headers)) {
      console.log(`  ${key}: ${value}`);
    }
    if (body) {
      console.log("--- Body ---");
      console.log(`  ${body}`);
    }
    console.log("====================\n");

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", received: body || null }));
  });
});

server.listen(3000, () => console.log("Listening on http://localhost:3000"));
