/* 小学（1–6 年级数学）题库体检。
 *
 * 背景（2026-10-27）：家长反复问「这是什么题啊，看不懂」。查下来是几种模板留下的毛病：
 *   - 题干末尾挂一句裸算式（「…要拼几个正方形？计算：360÷90＝？」）
 *   - 题干结尾停在一个没写完的算式上（「先写商，再写余数。商和余数：13÷5」）
 *   - 「解决问题」类知识点里全是裸算式（「两位数乘法的应用」配「计算：16×12＝？」）
 * 这个测试把这些都钉住，以后改题库跑一遍就知道有没有再犯。
 *
 * 跑法：node tests/test_questions_quality.js
 * 只查小学 1–6 年级数学；初中/高中和语英物暂不在范围内。
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
  return t && t.grade >= 1 && t.grade <= 6 && (!t.subject || t.subject === 'math');
});

/* 「计算：…＝？」这种只测算得快不算懂不懂的题；纯计算类知识点可以有 */
const isDrill = function (q) {
  const p = String(q.prompt || '');
  return /^计算[:：]/.test(p) && /[＝=]\s*[？?]/.test(p);
};
/* 知识点名里带这些词，说明考的是「用」，不是「算」 */
const isApplied = function (t) { return /应用|问题|解决|实际|情境/.test(t.name || ''); };

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

console.log('\n小学题库 ' + primary.length + ' 题，' + new Set(primary.map(function (q) { return q.topicId; })).size + ' 个知识点');

/* 1. 题干别停在没写完的算式上 */
ok('题干不以「：算式」结尾', primary.filter(function (q) {
  return /[：:]\s*[\d（）()+\-－×÷/.＝= ]{3,}$/.test(String(q.prompt || '').trim());
}));

/* 2. 「解决问题」类知识点里不要裸算式 */
ok('应用类知识点没有裸算式', primary.filter(function (q) {
  return isDrill(q) && isApplied(T[q.topicId]);
}));

/* 3. 同一个知识点里不重复出同一道题 */
(function () {
  const seen = {};
  const dup = [];
  primary.forEach(function (q) {
    const k = q.topicId + '|' + String(q.prompt || '').trim();
    if (seen[k]) dup.push(q); else seen[k] = 1;
  });
  ok('同点不重复题干', dup);
})();

/* 4. 选择题：至少 3 个选项、选项互不相同、答案在选项里 */
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

/* 5. 基本完整性 */
ok('题干 ≥6 字', primary.filter(function (q) { return String(q.prompt || '').trim().length < 6; }));
ok('答案不为空', primary.filter(function (q) { return String(q.answer == null ? '' : q.answer).trim() === ''; }));
ok('解析不为空', primary.filter(function (q) { return !String(q.explanation || '').trim(); }));

/* 6. 首题契约：q1 要承接 topics 里的 diagnostic_question（或注明改写过） */
ok('q1 承接 diagnostic_question', primary.filter(function (q) {
  if (!/_q1$/.test(q.id)) return false;
  const t = T[q.topicId];
  const dq = t && t.diagnostic_question && t.diagnostic_question.question;
  if (!dq) return false;
  return !String(q.prompt || '').startsWith(dq) && !q.fixed_from_source;
}));

/* 7. 首题的答案要和 topics 里记的一致（改题干时最容易漏的地方） */
ok('q1 答案与 diagnostic_question 一致', primary.filter(function (q) {
  if (!/_q1$/.test(q.id)) return false;
  const t = T[q.topicId];
  const dq = t && t.diagnostic_question;
  if (!dq || dq.answer == null) return false;
  const norm = function (x) { return String(x == null ? '' : x).replace(/\s+/g, '').trim(); };
  const mine = String(q.answer == null ? '' : q.answer).trim();
  if (q.type === 'choice') {
    /* topics 里记的是选项文字，题库里存的是字母，比之前先把字母翻成文字 */
    const opt = (q.choices || []).find(function (c) { return c.key === mine; });
    if (!opt) return true;                 // 字母对不上选项，另有规则管
    return norm(opt.text) !== norm(dq.answer) && mine !== String(dq.answer).trim();
  }
  return norm(mine) !== norm(dq.answer);
}));

/* 8. 每个知识点至少 3 题（够两次作答 + 一次换题） */
(function () {
  const byTopic = {};
  primary.forEach(function (q) { byTopic[q.topicId] = (byTopic[q.topicId] || 0) + 1; });
  const thin = Object.keys(byTopic).filter(function (id) { return byTopic[id] < 3; })
    .map(function (id) { return { id: id, topicId: id, prompt: '只有 ' + byTopic[id] + ' 题' }; });
  ok('每个知识点 ≥3 题', thin);
})();

console.log('\n通过 ' + pass + ' / ' + (pass + fail) + (fail ? '  —— 有 ' + fail + ' 项要修' : ''));
process.exit(fail ? 1 : 0);
