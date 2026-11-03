import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatMarkdown, commandItems, parseChatCommand } from '../src/conversation-commands.ts';
test('core controls coexist with actual engine commands without duplicates; review resolves to the real skill', () => {
 const items = commandItems([{name:'model',description:'vendor model',argumentHint:''},{name:'code-review',description:'real review',argumentHint:''},{name:'custom-skill',description:'installed',argumentHint:'file'}]);
 assert.equal(items.filter(c=>c.name==='model').length,1);
 assert.equal(items.find(c=>c.name==='review')?.vendorName,'code-review');
 assert.equal(items.find(c=>c.name==='custom-skill')?.available,true);
 assert.equal(items.find(c=>c.name==='compact')?.available,false);
 assert.equal(items.find(c=>c.name==='memory')?.available,false);
 assert.equal(items.find(c=>c.name==='effort')?.available,true);
});
test('paths are not mistaken for commands and command arguments survive parsing',()=>{
 assert.equal(parseChatCommand('/Users/name/notes.pdf'),undefined);
 assert.deepEqual(parseChatCommand('/plan compare A and B'),{name:'plan',args:'compare A and B'});
 assert.deepEqual(parseChatCommand('/effort high'),{name:'effort',args:'high'});
});
test('export preserves Markdown rather than stripping its meaning',()=>{
 assert.equal(chatMarkdown([{role:'user',text:'why?'},{role:'assistant',text:'**A**\n\n```ts\nconst x=1;\n```'}]),'## 나\n\nwhy?\n\n## Claude\n\n**A**\n\n```ts\nconst x=1;\n```');
});
