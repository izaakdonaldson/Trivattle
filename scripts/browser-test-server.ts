import { fixture } from '../test/battle-fixture.js';
import { playerFixture } from '../test/player-fixture.js';
import { battleServer } from '../src/battle/server.js';
import { createApplication } from '../src/player/application.js';
import { cfg } from '../test/helpers.js';
import { join } from 'node:path';
const f = fixture(),
  p = await playerFixture();
const application = await createApplication({
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
  application,
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
