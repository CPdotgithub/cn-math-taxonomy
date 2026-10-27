/* 小学（1–6 年级）题库体检：数学、语文、英语。
 *
 * 背景（2026-10-27）：家长反复问「这是什么题啊，看不懂」。查下来是几种模板留下的毛病：
 *   - 数学：题干末尾挂一句裸算式（「…要拼几个正方形？计算：360÷90＝？」）、题干停在
 *     没写完的算式上（「商和余数：13÷5」）、「解决问题」类知识点里全是裸算式
 *   - 语文：题干只有代词，看不出问的是哪一课（「结果怎样？」「班长是谁？」）
 *   - 英语：题干空格和选项对不上
 * 这个测试把这些都钉住，以后改题库跑一遍就知道有没有再犯。
 *
 * 跑法：node tests/test_questions_quality.js
 * 只查小学 1–6 年级；初中、高中暂不在范围内。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const topics = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'topics.json'), 'utf8'));
const rawQ = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));
const questions = Array.isArray(rawQ) ? rawQ : Object.values(rawQ);

const T = {};
topics.forEach(function (t) { T[t.id] = t; });

const primary = questions.filter(function (q) {
  const t = T[q.topicId];
  return t && t.grade >= 1 && t.grade <= 6;
});
const bySubject = function (s) {
  return primary.filter(function (q) { return (T[q.topicId].subject || 'math') === s; });
};
const math = bySubject('math'), chinese = bySubject('chinese'), english = bySubject('english');

const isDrill = function (q) {
  const p = String(q.prompt || '');
  return /^计算[:：]/.test(p) && /[＝=]\s*[？?]/.test(p);
};
const isApplied = function (t) { return /应用|问题|解决|实际|情境/.test(t.name || ''); };
const textOf = function (t) {
  const m = /《([^》]+)》/.exec((t && t.name) || '');
  return m ? m[1] : '';
};

let pass = 0, fail = 0;
function ok(name, list, hint) {
  if (!list.length) { pass++; console.log('  ✓ ' + name); return; }
  fail++;
  console.log('  ✗ ' + name + '（' + list.length + ' 条）' + (hint ? '  ' + hint : ''));
  list.slice(0, 8).forEach(function (x) {
    const q = x.question || x;
    console.log('      ' + q.id + ' ' + (T[q.topicId] ? T[q.topicId].name : q.topicId) +
      ' | ' + JSON.stringify(String(q.prompt || '').slice(0, 56)));
  });
}

console.log('\n小学题库 ' + primary.length + ' 题（数学 ' + math.length + ' / 语文 ' + chinese.length +
  ' / 英语 ' + english.length + '），' + new Set(primary.map(function (q) { return q.topicId; })).size + ' 个知识点');

console.log('\n[通用]');
ok('选择题选项 ≥3', primary.filter(function (q) {
  return q.type === 'choice' && (q.choices || []).length < 3;
}));
ok('选择题选项不重复', primary.filter(function (q) {
  if (q.type !== 'choice') return false;
  const texts = (q.choices || []).map(function (c) { return String(c.text || '').trim(); });
  return new Set(texts).size !== texts.length;
}));
ok('选择题答案在选项里', primary.filter(function (q) {
  if (q.type !== 'choice') return false;
  return !(q.choices || []).some(function (c) { return c.key === q.answer; });
}));
ok('选项文本不为空', primary.filter(function (q) {
  return (q.choices || []).some(function (c) { return !String(c.text || '').trim(); });
}));
ok('题干 ≥6 字', primary.filter(function (q) { return String(q.prompt || '').trim().length < 6; }));
ok('答案不为空', primary.filter(function (q) { return String(q.answer == null ? '' : q.answer).trim() === ''; }));
ok('解析不为空', primary.filter(function (q) { return !String(q.explanation || '').trim(); }));
ok('题干不含套话', primary.filter(function (q) { return /本题|以下选项|上述|如上/.test(q.prompt || ''); }));
ok('题干不以「：算式」结尾', primary.filter(function (q) {
  return /[：:]\s*[\d（）()+\-－×÷/.＝= ]{3,}$/.test(String(q.prompt || '').trim());
}));

(function () {
  const seen = {};
  const dup = [];
  primary.forEach(function (q) {
    const k = q.topicId + '|' + String(q.prompt || '').trim();
    if (seen[k]) dup.push(q); else seen[k] = 1;
  });
  ok('同点不重复题干', dup);
})();

ok('q1 承接 diagnostic_question', primary.filter(function (q) {
  if (!/_q1$/.test(q.id)) return false;
  const t = T[q.topicId];
  const dq = t && t.diagnostic_question && t.diagnostic_question.question;
  if (!dq) return false;
  return !String(q.prompt || '').startsWith(dq) && !q.fixed_from_source;
}));

ok('q1 答案与 diagnostic_question 一致', primary.filter(function (q) {
  if (!/_q1$/.test(q.id)) return false;
  const t = T[q.topicId];
  const dq = t && t.diagnostic_question;
  if (!dq || dq.answer == null) return false;
  const norm = function (x) { return String(x == null ? '' : x).replace(/\s+/g, '').trim(); };
  const mine = String(q.answer == null ? '' : q.answer).trim();
  if (q.type === 'choice') {
    const opt = (q.choices || []).find(function (c) { return c.key === mine; });
    if (!opt) return true;
    return norm(opt.text) !== norm(dq.answer) && mine !== String(dq.answer).trim();
  }
  return norm(mine) !== norm(dq.answer);
}));

(function () {
  const byTopic = {};
  primary.forEach(function (q) { byTopic[q.topicId] = (byTopic[q.topicId] || 0) + 1; });
  const thin = Object.keys(byTopic).filter(function (id) { return byTopic[id] < 3; })
    .map(function (id) { return { id: id, topicId: id, prompt: '只有 ' + byTopic[id] + ' 题' }; });
  ok('每个知识点 ≥3 题', thin);
})();

console.log('\n[数学]');
ok('应用类知识点没有裸算式', math.filter(function (q) { return isDrill(q) && isApplied(T[q.topicId]); }));

console.log('\n[语文]');
ok('课文类题干带课文名', chinese.filter(function (q) {
  const name = textOf(T[q.topicId]);
  if (!name) return false;
  const p = String(q.prompt || '').trim();
  if (/《/.test(p)) return false;
  return p.length <= 10 || /^(结果|他|她|它|这|那|为什么|怎样|怎么|后来|最后)/.test(p);
}));

console.log('\n[英语]');
ok('英文填空的选项不带空格线', english.filter(function (q) {
  if (!/_{2,}/.test(q.prompt || '')) return false;
  return (q.choices || []).some(function (c) { return /_{2,}/.test(String(c.text || '')); });
}));
ok('数值题答案是数字', english.filter(function (q) {
  return q.type === 'numeric' && !/\d/.test(String(q.answer == null ? '' : q.answer));
}));

console.log('\n通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  —— 有 ' + fail + ' 项要修' : ''));
process.exit(fail ? 1 : 0);
