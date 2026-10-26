/* 复习与考察 · 提示词
   ----------------------------------------------------------------------------
   两段提示：出题（一整套，低/中/高三档各一题）、批改（只批主观题 + 给整体判断）。
   约定：模型只输出 JSON；数学符号一律 Unicode，不用 LaTeX / Markdown。
   ========================================================================== */
(function () {
  'use strict';

  var SUBJECT_NAME = { math: '数学', chinese: '语文', english: '英语', physics: '物理' };

  var SYSTEM = [
    '你是一位资深教研员，负责为中国大陆的中小学生命制与批改测评题。',
    '必须遵守：',
    '1. 严格贴合《义务教育课程标准（2022 年版）》或《普通高中课程标准》，以及学生所在年级、教材版本的进度，不出超纲题、偏题、怪题。',
    '2. 每道题必须有确定答案或可量化的评分点；数据要能验算，情境要真实合理，不出需要查阅外部资料才能作答的题。',
    '3. 不使用 LaTeX、Markdown、表格；数学符号一律用 Unicode 字符（× ÷ ± ≤ ≥ ≠ ≈ √ π ∠ △ ° ² ³ ½），分数写成 3/4，带分数写成 1又3/4，角写成 ∠ABC。',
    '4. 面向学生，语言简洁具体；不讲空话，不出现“本题”“以下选项中”以外的套话。',
    '5. 出完题后必须逐题自检：把答案重新算一遍，核对位数、量级、单位、符号、选项标号是否都正确；哪道题自己没法百分之百确认，就换一道更稳妥的题。',
    '6. 只输出一个 JSON 对象。不要输出任何解释文字，不要使用代码块围栏，不要输出注释。'
  ].join('\n');

  var LEVELS = [
    { key: 'low', name: '基础巩固', hint: '单一概念或单步运算，考“会不会”' },
    { key: 'mid', name: '变式应用', hint: '2–3 步，需要转化、估算或情境建模，考“会不会用”' },
    { key: 'high', name: '综合迁移', hint: '跨知识点或带易错陷阱，需要推理、说理或多步规划，考“能不能迁移”' }
  ];

  function clip(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    var chars = Array.from(t);
    return chars.length > n ? chars.slice(0, n).join('') + '…' : t;
  }

  function topicLine(t, i) {
    var out = [];
    out.push((i + 1) + '. [' + t.id + '] ' + t.name);
    if (t.chapter) out.push('   教材位置：' + t.chapter);
    if (t.description) out.push('   这个点在说什么：' + clip(t.description, 120));
    if (t.mastery_criteria && t.mastery_criteria.length) {
      out.push('   学生应该会：' + t.mastery_criteria.slice(0, 3).map(function (x) { return clip(x, 40); }).join('；'));
    }
    if (t.state) out.push('   当前状态：' + t.state);
    return out.join('\n');
  }

  /* ctx: { grade, textbook, subject, topics:[{id,name,chapter,description,mastery_criteria,state}], count } */
  function setPrompt(ctx) {
    var subj = SUBJECT_NAME[ctx.subject] || '数学';
    var per = Math.max(1, Math.min(2, ctx.count || 1));
    var n = per * 3;

    var lines = [];
    lines.push('请为下面这名学生出一套「薄弱点综合考察」题。');
    lines.push('');
    lines.push('学生：' + (ctx.grade || '未知年级') + (ctx.textbook ? ' · ' + ctx.textbook : '') + ' · 学科：' + subj);
    lines.push('薄弱知识点（题目只能围绕这些点，允许跨点综合）：');
    (ctx.topics || []).forEach(function (t, i) { lines.push(topicLine(t, i)); });
    lines.push('');
    lines.push('共 ' + n + ' 题：低、中、高三档各 ' + per + ' 题。三档的定义：');
    LEVELS.forEach(function (l) { lines.push('- ' + l.key + '（' + l.name + '）：' + l.hint); });
    lines.push('');
    lines.push('每档的题型固定：');
    lines.push('- low：单项选择题，4 个选项，只有一个正确。');
    lines.push('- mid：填空题，1–2 个空，答案要短、唯一、能精确比对（数字、一个词或一个带单位的量）。');
    lines.push('- high：解答题，满分 4–6 分，必须写出分步评分点。');
    lines.push('');
    lines.push('命题要求：');
    lines.push('- 同一套题的几道题不要互相提示答案，不要只是换数字。');
    lines.push('- 选择题干扰项来自真实易错（小数点位置、进位退位、单位换算、概念混淆等），不要随便凑数。');
    lines.push('- 填空题的空用 ____ 表示，题干里 ____ 的个数必须与 blanks 数组长度完全一致（1–2 个空，最多 2 个）。');
    lines.push('- 解答题的评分点要写成可判定的动作，分值之和等于满分。');
    lines.push('- 每题的 explain 是给学生的讲评：说清思路、错因，60–120 字。');
    lines.push('');
    lines.push('输出 JSON，严格按此结构（字段名不要改，不要加多余字段）：');
    lines.push('{');
    lines.push('  "title": "不超过 16 个字，如 四年级小数乘法·综合考察",');
    lines.push('  "questions": [');
    lines.push('    {');
    lines.push('      "id": "q1", "topicId": "上面括号里的知识点 id", "topicName": "知识点名",');
    lines.push('      "level": "low", "type": "choice",');
    lines.push('      "stem": "题干，不含选项",');
    lines.push('      "options": ["选项内容A", "选项内容B", "选项内容C", "选项内容D"],');
    lines.push('      "answerIndex": 0,');
    lines.push('      "explain": "讲评",');
    lines.push('      "rubric": []');
    lines.push('    },');
    lines.push('    {');
    lines.push('      "id": "q2", "topicId": "…", "topicName": "…",');
    lines.push('      "level": "mid", "type": "blank",');
    lines.push('      "stem": "题干，空格用 ____ 表示",');
    lines.push('      "blanks": [{ "accept": ["可接受的写法1", "可接受的写法2"] }],');
    lines.push('      "answerText": "（1）… （2）…",');
    lines.push('      "explain": "讲评",');
    lines.push('      "rubric": [{ "point": "第 1 空", "score": 1 }, { "point": "第 2 空", "score": 1 }]');
    lines.push('    },');
    lines.push('    {');
    lines.push('      "id": "q3", "topicId": "…", "topicName": "…",');
    lines.push('      "level": "high", "type": "solution",');
    lines.push('      "stem": "题干",');
    lines.push('      "answerText": "参考答案，含关键步骤",');
    lines.push('      "fullScore": 5,');
    lines.push('      "rubric": [{ "point": "列式正确", "score": 2 }, { "point": "计算正确", "score": 2 }, { "point": "结论与单位", "score": 1 }],');
    lines.push('      "explain": "讲评：常见错误与思路"');
    lines.push('    }');
    lines.push('  ]');
    lines.push('}');
    return lines.join('\n');
  }

  /* 网页素材（可选）：只是题型与考法的参考，不作为答案依据 */
  function webBlock(items) {
    if (!items || !items.length) return '';
    var out = ['', '参考素材（来自网页，只能用来把握题型、考法和常见易错点；可能与教材版本不符，答案一律以你的学科判断为准，不得照抄）:'];
    items.slice(0, 3).forEach(function (it, i) {
      out.push('【' + (i + 1) + '】' + clip(it.title || it.url, 40));
      out.push(clip(it.text, 900));
    });
    return out.join('\n');
  }

  /* 批改：subjective：[{id, level, stem, answerText, rubric, fullScore, studentAnswer}]
     objective：[{id, level, type, got, full, verdict}] —— 客观题已由前端判好，这里只用于写整体判断 */
  function gradePrompt(ctx) {
    var lines = [];
    lines.push('你在批改学生的作答。只批改下面列出的解答题，并给出整体判断。');
    lines.push('');
    lines.push('学生：' + (ctx.grade || '未知年级') + ' · 学科 ' + (SUBJECT_NAME[ctx.subject] || '数学'));
    lines.push('');
    (ctx.subjective || []).forEach(function (q) {
      lines.push('【' + q.id + '】难度：' + q.level + ' · 满分 ' + q.fullScore + ' 分');
      lines.push('题干：' + q.stem);
      lines.push('参考答案：' + (q.answerText || '（无）'));
      lines.push('评分点：' + (q.rubric || []).map(function (r) { return r.point + '（' + r.score + '分）'; }).join('；'));
      lines.push('学生作答：');
      lines.push(String(q.studentAnswer || '（空白）').slice(0, 1200));
      lines.push('');
    });
    if (ctx.objective && ctx.objective.length) {
      lines.push('客观题结果（系统已判好，不用你重新判，只用来写 summary）：');
      ctx.objective.forEach(function (o) {
        lines.push('- ' + o.id + '（' + o.level + '·' + (o.type === 'choice' ? '选择' : '填空') + '）得分 ' + o.got + '/' + o.full + '，' +
          (o.verdict === 'right' ? '全对' : o.verdict === 'partial' ? '部分对' : '错误或空白'));
      });
      lines.push('');
    }
    lines.push('批改规则：');
    lines.push('- 逐个评分点判断，总分只能是评分点分值之和，不得超过满分。');
    lines.push('- 学生用了与参考答案不同但正确的方法，必须给分。');
    lines.push('- 只写答案没有过程：结论分给，过程分不给。');
    lines.push('- 空白或完全跑题：0 分，但要指出该先补哪个点。');
    lines.push('- 评语面向学生，指出具体错在哪一步，不要空泛鼓励。');
    lines.push('- 提到某道题时说「基础题 / 变式题 / 综合题」，不要用 q1、q2 这种内部编号。');
    lines.push('');
    lines.push('输出 JSON（字段名不要改）：');
    lines.push('{');
    lines.push('  "items": [{ "id": "q3", "score": 3, "hits": ["做到了什么"], "miss": ["漏了哪一步"], "comment": "30–80 字" }],');
    lines.push('  "summary": "整体判断，60–140 字，结合上面的客观题结果和你的批改，说清低/中/高三档各自的掌握情况，并指出最该补的一点",');
    lines.push('  "gaps": ["还没过关的点，最多 3 条，每条不超过 18 字"],');
    lines.push('  "next": "下一步怎么练，40–80 字，具体到动作"');
    lines.push('}');
    return lines.join('\n');
  }

  window.RvPrompts = {
    SYSTEM: SYSTEM,
    LEVELS: LEVELS,
    SUBJECT_NAME: SUBJECT_NAME,
    setPrompt: setPrompt,
    webBlock: webBlock,
    gradePrompt: gradePrompt
  };
})();
