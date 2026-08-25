const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');
if (!code.includes('/api/log-error')) {
  code = code.replace('app.get("/api/health"', 'app.post("/api/log-error", (req, res) => { console.error("CLIENT ERROR:", req.body); res.send("ok"); });\n\n  app.get("/api/health"');
  fs.writeFileSync('server.ts', code);
}
