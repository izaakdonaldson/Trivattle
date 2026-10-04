import { fixture } from '../test/battle-fixture.js';
import { playerFixture } from '../test/player-fixture.js';
import { battleServer } from '../src/battle/server.js';
import { createApplication } from '../src/player/application.js';
import { cfg } from '../test/helpers.js';
import { join } from 'node:path';
const f = fixture(),
  p = await playerFixture();
let clockOffset = 0;
const application = await createApplication({
  now: () => Date.now() + clockOffset,
  store: p.store,
  config: cfg(),
  refresh: () => {},
  dbPath: join(p.dir, 'browser.sqlite'),
  baseURL: 'http://127.0.0.1:3101',
  secret: 'browser-testing-secret-1234567890123456789',
  choose: (n) => (n === 100 ? 99 : 0),
});
const server = battleServer({
  store: f.store,
  config: cfg(),
  choose: () => 0,
  application: {
    ...application,
    async handle(req, res) {
      // This endpoint exists only in the isolated Playwright fixture server.
      if (req.url === '/__test/clock' && req.method === 'POST') {
        let text = '';
        for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        if (body.reset === true) clockOffset = 0;
        else if (
          Number.isSafeInteger(body.advance) &&
          body.advance >= 0 &&
          body.advance <= 86400000
        )
          clockOffset += body.advance;
        else {
          res.writeHead(400);
          res.end();
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ now: Date.now() + clockOffset }));
        return true;
      }
      return application.handle(req, res);
    },
  },
  localLab: true,
});
server.listen(3101, '127.0.0.1');
function stop() {
  application.close();
  server.close(() => {
    f.clean();
    p.clean();
    process.exit();
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
