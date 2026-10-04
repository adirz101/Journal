import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { JournalStore } from '../src/core/store.mjs';
import { TerminalManager } from '../src/core/terminal.mjs';
import { COLORFGBG, QueryResponder, themeReport, xtermRgb } from '../src/core/terminal-queries.mjs';
import { removeLater } from './support/cleanup.mjs';

const LIGHT_BG = '\x1b]11;rgb:fafa/fafa/fbfb'; const DARK_BG = '\x1b]11;rgb:0b0b/0d0d/1010';

test('COLORFGBG follows the rxvt convention that Claude Code and Cursor read', () => {
  // Both read the last field: 0-6 and 8 are dark backgrounds, 7 and 9-15 light.
  const background = value => Number(value.split(';').at(-1));
  assert.equal(COLORFGBG.light, '0;15'); assert.equal(COLORFGBG.dark, '15;0');
  assert.ok(background(COLORFGBG.light) > 8); assert.ok(background(COLORFGBG.dark) <= 6);
});

test('colours are reported the way xterm reports them', () => {
  assert.equal(xtermRgb('#FAFAFB'), 'rgb:fafa/fafa/fbfb'); assert.equal(xtermRgb('#0B0D10'), 'rgb:0b0b/0d0d/1010');
});

test('OSC 10, 11 and 12 queries are answered with the current appearance and the same terminator', () => {
  const responder = new QueryResponder();
  assert.equal(responder.feed('\x1b]11;?\x07', { appearance: 'light' }), `${LIGHT_BG}\x07`);
  assert.equal(responder.feed('\x1b]11;?\x1b\\', { appearance: 'dark' }), `${DARK_BG}\x1b\\`);
  // OSC 10;?;? asks for the foreground and then the background.
  assert.equal(responder.feed('\x1b]10;?;?\x07', { appearance: 'light' }), '\x1b]10;rgb:1414/1717/1c1c\x07\x1b]11;rgb:fafa/fafa/fbfb\x07');
  assert.equal(responder.feed('\x1b]12;?\x07', { appearance: 'dark' }), '\x1b]12;rgb:6a6a/a5a5/ffff\x07');
  // Setting a colour, a palette query and ordinary output get no answer from the runtime.
  assert.equal(responder.feed('\x1b]11;#ffffff\x07\x1b]4;1;?\x07\x1b]0;title\x07plain \x1b[31mred\x1b[0m'), '');
});

test('a query split across chunks is answered once it is complete', () => {
  const responder = new QueryResponder();
  assert.equal(responder.feed('output \x1b]1', { appearance: 'light' }), '');
  assert.equal(responder.feed('1;', { appearance: 'light' }), '');
  assert.equal(responder.feed('?\x1b', { appearance: 'light' }), '');
  assert.equal(responder.feed('\\more', { appearance: 'light' }), `${LIGHT_BG}\x1b\\`);
  assert.equal(responder.feed('\x1b'), ''); assert.equal(responder.feed('[c', { attached: false }), '\x1b[?1;2c');
  // A long unterminated OSC (a large title or clipboard write) is not kept.
  responder.feed(`\x1b]0;${'x'.repeat(2000)}`); assert.equal(responder.carry, '');
});

test('DA1 is answered only while no window is attached; an attached terminal answers it in order', () => {
  const responder = new QueryResponder();
  assert.equal(responder.feed('\x1b[c', { attached: false }), '\x1b[?1;2c');
  assert.equal(responder.feed('\x1b[0c', { attached: false }), '\x1b[?1;2c');
  assert.equal(responder.feed('\x1b[c', { attached: true }), '');
  assert.equal(responder.feed('\x1b[>c', { attached: false }), '', 'DA2 is not DA1');
});

test('mode 2031 is tracked, and its report request is answered', () => {
  const responder = new QueryResponder();
  responder.feed('\x1b[?2004;2031h'); assert.equal(responder.themeReports, true);
  assert.equal(responder.feed('\x1b[?996n', { appearance: 'light' }), themeReport('light'));
  assert.equal(themeReport('light'), '\x1b[?997;2n'); assert.equal(themeReport('dark'), '\x1b[?997;1n');
  responder.feed('\x1b[?2031l'); assert.equal(responder.themeReports, false);
});

function harness(t) {
  const root = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'queries-'));
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  const store = new JournalStore(':memory:'); const project = store.openProject(root); const launches = [];
  const manager = new TerminalManager({ store, trackMs: 0, identify: () => null, table: () => null, spawn: (executable, argv, options) => {
    const pty = { inputs: [], env: options.env, onData: f => { pty.data = f; }, onExit: f => { pty.exit = f; }, write: data => pty.inputs.push(data), resize() {}, kill() {} };
    launches.push(pty); return pty;
  }});
  t.after(async () => { await manager.dispose(); store.close(); removeLater(root); });
  return { project, manager, launches };
}

test('the launch environment carries COLORFGBG for the appearance, for a start and a resume', async t => {
  const f = harness(t);
  const previous = process.env.COLORFGBG; process.env.COLORFGBG = '15;0';
  t.after(() => { if (previous === undefined) delete process.env.COLORFGBG; else process.env.COLORFGBG = previous; });
  // The terminal Journal was started from does not decide: its COLORFGBG is replaced.
  const light = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: '', appearance: 'light' });
  assert.equal(f.launches[0].env.COLORFGBG, '0;15');
  f.launches[0].exit({ exitCode: 0 });
  await f.manager.start({ projectId: f.project.id, provider: 'claude', resumeId: light.session.id, appearance: 'dark' });
  assert.equal(f.launches[1].env.COLORFGBG, '15;0');
  // Without an appearance (an earlier main), the last one known is used.
  await f.manager.start({ projectId: f.project.id, provider: 'codex', task: '' });
  assert.equal(f.launches[2].env.COLORFGBG, '15;0');
  // An unknown value is ignored too.
  f.launches[2].exit({ exitCode: 0 });
  await f.manager.start({ projectId: f.project.id, provider: 'codex', task: '', appearance: 'sepia' });
  assert.equal(f.launches[3].env.COLORFGBG, '15;0');
});

test('the runtime answers a detached session, leaves DA1 to an attached window, and reports a switch', async t => {
  const f = harness(t);
  const { session } = await f.manager.start({ projectId: f.project.id, provider: 'claude', task: '', appearance: 'light' });
  const pty = f.launches[0];
  pty.data('\x1b[?2031h\x1b]11;?\x07\x1b[c');
  assert.deepEqual(pty.inputs, [`${LIGHT_BG}\x07\x1b[?1;2c`]);
  f.manager.attach(session.id); pty.inputs.length = 0;
  pty.data('\x1b]11;?\x07\x1b[c');
  assert.deepEqual(pty.inputs, [`${LIGHT_BG}\x07`], 'the window answers DA1');
  // The same appearance again reports nothing; a switch tells the CLI, which asks again.
  pty.inputs.length = 0;
  assert.deepEqual(f.manager.setAppearance('light'), { reported: 0 });
  assert.deepEqual(f.manager.setAppearance('dark'), { reported: 1 });
  assert.deepEqual(pty.inputs, ['\x1b[?997;1n']);
  pty.data('\x1b]11;?\x07');
  assert.equal(pty.inputs.at(-1), `${DARK_BG}\x07`);
  assert.throws(() => f.manager.setAppearance('sepia'), /Invalid appearance/);
  // A session that did not enable mode 2031 gets no report.
  pty.data('\x1b[?2031l'); pty.inputs.length = 0; f.manager.setAppearance('light'); assert.deepEqual(pty.inputs, []);
  // Typed input timing is untouched by the runtime's own answers.
  assert.equal(f.manager.entry(session.id).lastInputAt, 0);
});
