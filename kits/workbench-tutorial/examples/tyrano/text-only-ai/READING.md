# 只读原文与上下文

## data/scenario/demo.ks:00001

原文：

```text
Clerk
```

带保护符的原文：`Clerk`

上下文：`{"label": "*start"}`

## data/scenario/demo.ks:00002

原文：

```text
Welcome.[l]
Please enter.[p]
```

带保护符的原文：`Welcome.{{CTRL0001}}{{CTRL0002}}Please enter.{{CTRL0003}}`

上下文：`{"speaker": "Clerk", "label": "*start", "line": 3}`

## data/scenario/demo.ks:00003

原文：

```text
Confirm
```

带保护符的原文：`Confirm`

上下文：`{"attribute": "text", "label": "*start"}`
