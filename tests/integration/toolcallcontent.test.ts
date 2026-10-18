import * as assert from 'assert';
import { suite, test } from 'mocha';

// Test extraction logic matching ChatWebviewProvider
function extractToolCallBlocks(content: any[] | undefined | null): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object') {
      continue;
    }
    const inner = block.content;
    if (block.type === 'content' && inner && typeof inner === 'object'
      && inner.type === 'text' && typeof inner.text === 'string') {
      blocks.push(inner.text);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push(block.text);
    }
  }
  return blocks;
}

suite('Tool Call Content Test Suite', () => {
  test('Extracts text from nested ACP ToolCallContent format', () => {
    const content = [
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Running test suite...\n3 passing',
        },
      },
    ];

    const blocks = extractToolCallBlocks(content);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0], 'Running test suite...\n3 passing');
  });

  test('Extracts text from flat text format', () => {
    const content = [
      {
        type: 'text',
        text: 'Command output line 1',
      },
      {
        type: 'text',
        text: 'Command output line 2',
      },
    ];

    const blocks = extractToolCallBlocks(content);
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0], 'Command output line 1');
    assert.strictEqual(blocks[1], 'Command output line 2');
  });

  test('Ignores non-text and malformed blocks safely', () => {
    const content = [
      null,
      undefined,
      {},
      { type: 'diff', path: 'file.txt' },
      { type: 'content', content: { type: 'image', uri: 'data:image/png;base64,...' } },
      { type: 'content', content: { type: 'text', text: 'Valid text block' } },
    ];

    const blocks = extractToolCallBlocks(content);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0], 'Valid text block');
  });

  test('Handles null and undefined content inputs gracefully', () => {
    assert.deepStrictEqual(extractToolCallBlocks(null), []);
    assert.deepStrictEqual(extractToolCallBlocks(undefined), []);
    assert.deepStrictEqual(extractToolCallBlocks([]), []);
  });
});
