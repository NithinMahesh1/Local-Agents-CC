import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeSettingsPath,
  readSavedModel,
  replaceModelLine,
  restoreSavedModel
} from '../src/settings-guard.js';

test('replaceModelLine', async (t) => {
  await t.test('1. returns null if model does not match', () => {
    assert.strictEqual(replaceModelLine('{\n  "model": "opus"\n}\n', 'local-model', 'opus'), null);
  });

  await t.test('2. replaces model with new value', () => {
    const input = '{\n  "model": "local-model",\n  "theme": "dark"\n}\n';
    const expected = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
    assert.strictEqual(replaceModelLine(input, 'local-model', 'opus'), expected);
  });

  await t.test('3. replaces model with new value (non-first key)', () => {
    const input = '{\n  "theme": "dark",\n  "model": "local-model"\n}\n';
    const expected = '{\n  "theme": "dark",\n  "model": "opus"\n}\n';
    assert.strictEqual(replaceModelLine(input, 'local-model', 'opus'), expected);
  });

  await t.test('4. removes model if modelBefore is empty (with comma)', () => {
    const input = '{\n  "model": "local-model",\n  "theme": "dark"\n}\n';
    const expected = '{\n  "theme": "dark"\n}\n';
    assert.strictEqual(replaceModelLine(input, 'local-model', ''), expected);
  });

  await t.test('5. removes model if modelBefore is empty (no comma, last key)', () => {
    const input = '{\n  "theme": "dark",\n  "model": "local-model"\n}\n';
    const expected = '{\n  "theme": "dark"\n}\n';
    const result = replaceModelLine(input, 'local-model', '');
    assert.strictEqual(result, expected);
    assert.deepStrictEqual(JSON.parse(result), { theme: 'dark' });
  });

  await t.test('6. works with CRLF', () => {
    const input = '{\r\n  "model": "local-model",\r\n  "theme": "dark"\r\n}\r\n';
    const expected = '{\r\n  "model": "opus",\r\n  "theme": "dark"\r\n}\r\n';
    assert.strictEqual(replaceModelLine(input, 'local-model', 'opus'), expected);
  });

  await t.test('7. works with no line end after the line', () => {
    const input = '  "model": "local-model"';
    const expected = '  "model": "opus"';
    assert.strictEqual(replaceModelLine(input, 'local-model', 'opus'), expected);
  });

  await t.test('8. throws error if multiple top-level lines match', () => {
    const input = '{\n  "model": "local-model",\n  "model": "local-model"\n}\n';
    assert.throws(() => replaceModelLine(input, 'local-model', 'opus'), {
      message: 'the "model" line does not have the expected format'
    });
  });

  await t.test('9. throws error if nested line matches', () => {
    const input = '{\n  "agents": {\n    "model": "local-model"\n  }\n}\n';
    assert.throws(() => replaceModelLine(input, 'local-model', 'opus'), {
      message: 'the "model" line does not have the expected format'
    });
  });

  await t.test('10. throws error for minified JSON', () => {
    const input = '{"model":"local-model"}';
    assert.throws(() => replaceModelLine(input, 'local-model', 'opus'), {
      message: 'the "model" line does not have the expected format'
    });
  });

  await t.test('11. handles regex characters in model name', () => {
    const input1 = '{\n  "model": "localXmodel+1",\n  "a": 1\n}\n';
    assert.strictEqual(replaceModelLine(input1, 'local.model+1', 'opus'), null);

    const input2 = '{\n  "model": "local.model+1",\n  "a": 1\n}\n';
    const expected = '{\n  "model": "opus",\n  "a": 1\n}\n';
    assert.strictEqual(replaceModelLine(input2, 'local.model+1', 'opus'), expected);
  });

  await t.test('12. handles backslash and double quote in modelBefore', () => {
    const input = '{\n  "model": "local-model",\n  "theme": "dark"\n}\n';
    const modelBefore = 'a\\b"c';
    const result = replaceModelLine(input, 'local-model', modelBefore);
    assert.strictEqual(JSON.parse(result).model, 'a\\b"c');
  });

  await t.test('13. handles spaces after the comma', () => {
    const input = '{\n  "model": "local-model",  \n  "theme": "dark"\n}\n';
    const expected = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
    assert.strictEqual(replaceModelLine(input, 'local-model', 'opus'), expected);
  });
});

test('readSavedModel', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-'));
  try {
    await t.test('14. handles various file scenarios', async () => {
      const missingFile = path.join(tmpDir, 'missing.json');
      assert.strictEqual(readSavedModel(missingFile), '');

      const notJson = path.join(tmpDir, 'notjson.json');
      fs.writeFileSync(notJson, 'not json');
      assert.strictEqual(readSavedModel(notJson), '');

      const noModel = path.join(tmpDir, 'nomodel.json');
      fs.writeFileSync(noModel, JSON.stringify({ theme: 'dark' }));
      assert.strictEqual(readSavedModel(noModel), '');

      const modelNotString = path.join(tmpDir, 'modelnotstring.json');
      fs.writeFileSync(modelNotString, JSON.stringify({ model: 5 }));
      assert.strictEqual(readSavedModel(modelNotString), '');

      const modelIsString = path.join(tmpDir, 'modelisstring.json');
      fs.writeFileSync(modelIsString, JSON.stringify({ model: 'opus' }));
      assert.strictEqual(readSavedModel(modelIsString), 'opus');

      const bomFile = path.join(tmpDir, 'bom.json');
      const bomContent = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ model: 'sonnet' }))]);
      fs.writeFileSync(bomFile, bomContent);
      assert.strictEqual(readSavedModel(bomFile), 'sonnet');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('claudeSettingsPath', async (t) => {
  await t.test('15. returns correct path based on env', () => {
    const dir = path.join(os.tmpdir(), 'claude-config');
    assert.strictEqual(claudeSettingsPath({ CLAUDE_CONFIG_DIR: dir }), path.join(dir, 'settings.json'));
    assert.strictEqual(claudeSettingsPath({}), path.join(os.homedir(), '.claude', 'settings.json'));
    assert.strictEqual(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '  ' }), path.join(os.homedir(), '.claude', 'settings.json'));
  });
});

test('restoreSavedModel', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-'));
  try {
    await t.test('16. handles missing file', async () => {
      const notes = [];
      const settingsPath = path.join(tmpDir, 'nonexistent.json');
      await restoreSavedModel({
        settingsPath,
        localModel: 'local-model',
        modelBefore: 'opus',
        note: (m) => notes.push(m)
      });
      assert.strictEqual(notes.length, 0);
      assert.strictEqual(fs.existsSync(settingsPath), false);
    });

    await t.test('17. handles nothing to undo', async () => {
      const settingsPath = path.join(tmpDir, 'nothing-to-undo.json');
      const text = '{\n  "model": "opus"\n}\n';
      fs.writeFileSync(settingsPath, text);
      const notes = [];
      await restoreSavedModel({
        settingsPath,
        localModel: 'local-model',
        modelBefore: 'opus',
        note: (m) => notes.push(m)
      });
      assert.strictEqual(notes.length, 0);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), text);
    });

    await t.test('18. successfully restores model and calls note', async () => {
      const settingsPath = path.join(tmpDir, 'restore-success.json');
      const text = '{\n  "model": "local-model",\n  "theme": "dark"\n}\n';
      fs.writeFileSync(settingsPath, text);
      const notes = [];
      await restoreSavedModel({
        settingsPath,
        localModel: 'local-model',
        modelBefore: 'opus',
        note: (m) => notes.push(m)
      });
      const expectedText = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), expectedText);
      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0], '/model had saved local-model as the default for all sessions - changed it back to opus.');
      assert.strictEqual(fs.existsSync(settingsPath + '.local-agents-cc.tmp'), false);
    });

    await t.test('19. preserves BOM if present', async () => {
      const settingsPathWithBom = path.join(tmpDir, 'bom-restore.json');
      const bomContent = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{\n  "model": "local-model",\n  "theme": "dark"\n}\n')]);
      fs.writeFileSync(settingsPathWithBom, bomContent);

      const settingsPathNoBom = path.join(tmpDir, 'no-bom-restore.json');
      const noBomContent = '{\n  "model": "local-model",\n  "theme": "dark"\n}\n';
      fs.writeFileSync(settingsPathNoBom, noBomContent);

      const notes = [];
      await restoreSavedModel({
        settingsPath: settingsPathWithBom,
        localModel: 'local-model',
        modelBefore: 'opus',
        note: (m) => notes.push(m)
      });
      const restoredBom = fs.readFileSync(settingsPathWithBom);
      assert.strictEqual(restoredBom[0], 0xEF);
      assert.strictEqual(restoredBom[1], 0xBB);
      assert.strictEqual(restoredBom[2], 0xBF);

      await restoreSavedModel({
        settingsPath: settingsPathNoBom,
        localModel: 'local-model',
        modelBefore: 'opus',
        note: (m) => notes.push(m)
      });
      const restoredNoBom = fs.readFileSync(settingsPathNoBom);
      assert.notStrictEqual(restoredNoBom[0], 0xEF);
    });

    await t.test('20. handles errors in restoreSavedModel', async () => {
      const settingsPath = path.join(tmpDir, 'error-restore.json');
      // Test 8 input: multiple top-level lines
      const input = '{\n  "model": "local-model",\n  "model": "local-model"\n}\n';
      fs.writeFileSync(settingsPath, input);
      const notes = [];
      await restoreSavedModel({
        settingsPath,
        localModel: 'local-model',
        modelBefore: 'opus',
        note: (m) => notes.push(m)
      });
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), input);
      assert.strictEqual(notes.length, 1);
      assert.ok(notes[0].startsWith('WARNING - the default model in ' + settingsPath));
      assert.ok(notes[0].includes('the "model" line does not have the expected format'));
      assert.strictEqual(fs.existsSync(settingsPath + '.local-agents-cc.tmp'), false);
    });

    await t.test('21. uses "the built-in default" message when modelBefore is empty', async () => {
      const settingsPath = path.join(tmpDir, 'empty-modelBefore.json');
      const text = '{\n  "model": "local-model",\n  "theme": "dark"\n}\n';
      fs.writeFileSync(settingsPath, text);
      const notes = [];
      await restoreSavedModel({
        settingsPath,
        localModel: 'local-model',
        modelBefore: '',
        note: (m) => notes.push(m)
      });
      assert.strictEqual(notes[0], '/model had saved local-model as the default for all sessions - changed it back to the built-in default.');
    });

    if (process.platform !== 'win32') {
      await t.test('22. preserves file mode', async () => {
        const settingsPath = path.join(tmpDir, 'mode-preserve.json');
        const text = '{\n  "model": "local-model"\n}\n';
        fs.writeFileSync(settingsPath, text, { mode: 0o600 });
        const notes = [];
        await restoreSavedModel({
          settingsPath,
          localModel: 'local-model',
          modelBefore: 'opus',
          note: (m) => notes.push(m)
        });
        const mode = fs.statSync(settingsPath).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
