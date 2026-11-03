import test from 'ava';
// @ts-expect-error plain JavaScript module next to the Dockerfile
import { parseEntry } from '../docker/fetch-mods.mjs';

test('fetch-mods reads Modrinth pins and private file entries, and refuses odd names', (t) => {
  t.deepEqual(parseEntry('modrinth:flashback:0.43.6'), { kind: 'modrinth', project: 'flashback', version: '0.43.6' });
  t.deepEqual(parseEntry('agent-auth-fabric-26.2-1.0.0.jar=https://api.github.com/repos/o/r/releases/assets/1'),
    { kind: 'url', file: 'agent-auth-fabric-26.2-1.0.0.jar', url: 'https://api.github.com/repos/o/r/releases/assets/1' });
  t.throws(() => parseEntry('../x.jar=https://example.com/x'));
  t.throws(() => parseEntry('x.jar=http://insecure.example/x'));
  t.throws(() => parseEntry('whatever'));
});
