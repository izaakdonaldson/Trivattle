import { fixture } from '../test/battle-fixture.js';
import { battleServer } from '../src/battle/server.js';
import { cfg } from '../test/helpers.js';
const f = fixture();
const server = battleServer({ store: f.store, config: cfg(), choose: () => 0 });
server.listen(3101, '127.0.0.1');
function stop() {
  server.close();
  f.clean();
  process.exit();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
