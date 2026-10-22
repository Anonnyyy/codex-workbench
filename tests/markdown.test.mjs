import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';

const server=await createServer({server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
const {default:MarkdownMessage}=await server.ssrLoadModule('/src/MarkdownMessage.jsx');
after(()=>server.close());
const render=text=>renderToStaticMarkup(React.createElement(MarkdownMessage,{text}));

test('conversation Markdown renders summary tables, emphasis, lists and file links',()=>{
  const html=render('这个 `summary.json` 是**单场景闭环评估的汇总结果**。\n\n## 评估结果\n\n| 部分 | 内容 |\n|---|---|\n| `evaluation_scope` | `training_scene_retest` |\n\n- 第一项\n- 第二项\n\n[summary.json](/home/example/summary.json)');
  assert.match(html,/<strong>单场景闭环评估的汇总结果<\/strong>/);
  assert.match(html,/<h2>评估结果<\/h2>/);
  assert.match(html,/<table><thead><tr><th>部分<\/th><th>内容<\/th>/);
  assert.match(html,/<td><code>evaluation_scope<\/code><\/td>/);
  assert.match(html,/<li>第一项<\/li>/);
  assert.match(html,/href="\/home\/example\/summary.json"/);
});

test('conversation code blocks preserve indentation and highlight known languages',()=>{
  const html=render('```python\ndef hello():\n    return "你好"\n```\n\n```unknown-language\n  plain <code>\n```');
  assert.match(html,/<pre><code class="hljs language-python">/);
  assert.match(html,/hljs-keyword/);
  assert.match(html,/\n    /);
  assert.match(html,/<pre><code class="hljs language-unknown-language">  plain &lt;code&gt;\n<\/code><\/pre>/);
});

test('conversation Markdown keeps HTML inert and blocks executable links',()=>{
  const html=render('<script>alert(1)</script>\n\n[click](javascript:alert%281%29)\n\n普通文本');
  assert.doesNotMatch(html,/<script>|href="javascript:/);
  assert.match(html,/&lt;script&gt;/);
  assert.match(html,/普通文本/);
  assert.doesNotThrow(()=>render('```json\n{"incomplete":'));
});
