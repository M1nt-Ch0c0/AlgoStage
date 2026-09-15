# 04 · 数据模型与看板指标

> 存储：Prisma + SQLite（本地文件 `algostage.db`）。一期单用户，但所有表带 `userId` 外键，为多档案/云同步预留。

## 1. Prisma Schema（骨架）

```prisma
model User {
  id        String   @id @default(cuid())
  name      String   @default("default")
  createdAt DateTime @default(now())
  progress  ProblemProgress[]
  submissions Submission[]
  hintUsages  HintUsage[]
  reviewCards ReviewCard[]
  settings    Setting[]
}

model Problem {              // 元数据镜像（内容源可插拔，DB 只存引用与缓存）
  slug       String  @id     // 'two-sum'
  title      String
  number     Int
  difficulty String          // easy | medium | hard
  patterns   String          // JSON: ['hash-table']
  prereqs    String          // JSON: ['array-basics']
  order      Int             // 路线图排序
  progress   ProblemProgress[]
}

model ProblemProgress {      // 一题一行的学习档案
  userId      String
  problemSlug String
  status      String   @default("untouched") // untouched|learning|solved|mastered
  attempts    Int      @default(0)
  solvedAt    DateTime?
  lectureSeen Int      @default(0)   // 看过的讲解步数
  lastStepAt  DateTime?
  user     User    @relation(fields: [userId], references: [id])
  problem  Problem @relation(fields: [problemSlug], references: [slug])
  @@id([userId, problemSlug])
}

model Submission {           // playground 提交记录
  id        String   @id @default(cuid())
  userId    String
  problemSlug String
  code      String
  language  String
  verdict   String           // AC | WA | RE | TLE
  runtimeMs Int?
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id])
}

model HintUsage {            // 提示阶梯消耗（独立性指标数据源）
  id        String @id @default(cuid())
  userId    String
  problemSlug String
  level     Int              // 1-5
  createdAt DateTime @default(now())
  user      User   @relation(fields: [userId], references: [id])
}

model LectureScriptCache {   // AI 讲解脚本缓存
  key       String @id       // slug+model+lang+mode 的 hash
  script    String           // TeachingScript JSON
  createdAt DateTime @default(now())
}

model ReviewCard {           // SM-2 间隔复习
  id        String @id @default(cuid())
  userId    String
  problemSlug String
  ease      Float  @default(2.5)
  interval  Int    @default(0)   // 天
  dueAt     DateTime
  reps      Int    @default(0)
  lapses    Int    @default(0)
  user      User   @relation(fields: [userId], references: [id])
}

model Setting {              // BYOK 等设置（Key 仅存本地）
  key   String @id           // 'provider' | 'model' | 'apiKey' | 'theme' | 'effectLevel'
  value String
  userId String
  user  User @relation(fields: [userId], references: [id])
}
```

## 2. 看板指标定义

| 指标 | 计算 | 来源 |
|---|---|---|
| 热力图 | 按天聚合 Submission + 学习行为数 | `Submission.createdAt` |
| 知识点掌握度 | 每模式：`Σ(题分)/题数`，题分 = solved×0.6 + mastered×0.4 − 提示惩罚 | `ProblemProgress` + `HintUsage` |
| Streak | 连续有活动的天数 | Submission/Lecture 事件 |
| 独立性 | 无提示 AC 题数 / 总 AC 题数 | `HintUsage` 按题聚合 |
| 平均卡点 | 首次学习 → AC 的时长中位数 | `ProblemProgress` 时间戳 |
| 待复习 | `dueAt <= now` 的卡片数 | `ReviewCard` |

## 3. SM-2 复习规则（简版）

- 题目 AC 后自动生成复习卡（`interval=1` 天）。
- 复习时自评 0-5：≥3 → `interval = interval×ease`，`ease` 按 SM-2 公式微调；<3 → `interval=1`，`lapses+1`。
- 复习内容 = 重做该题或让 AI 出变式题（二期）。

## 4. 数据安全与迁移

- 全部数据留在用户本地 `algostage.db`；设置页提供"导出/导入 JSON"。
- Prisma migrate 管理 schema 演进；新增字段一律可空或带默认值，保证老库无缝升级。
