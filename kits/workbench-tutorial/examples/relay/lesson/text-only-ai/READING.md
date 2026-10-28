# 只读原文与上下文

## Actors:00001

原文：

```text
Lin
```

带保护符的原文：`Lin`

上下文：`{"record": 1, "field": "name"}`

## Actors:00002

原文：

```text
A traveler.
A new arrival.
```

带保护符的原文：`A traveler.{{CTRL0001}}A new arrival.`

上下文：`{"record": 1, "field": "profile"}`

## Map001:00001

原文：

```text
Inn
```

带保护符的原文：`Inn`

上下文：`{"map": "Map001"}`

## Map001:00002

原文：

```text
Clerk
```

带保护符的原文：`Clerk`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 0, "code": 101, "indent": 0, "branch_path": [], "line_count": 2, "face": "", "speaker": "Clerk"}`

## Map001:00003

原文：

```text
Hello, \N[1].
Come this way.
```

带保护符的原文：`Hello, {{CTRL0001}}.{{LINE0001}}Come this way.`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 0, "code": 101, "indent": 0, "branch_path": [], "line_count": 2, "face": "", "speaker": "Clerk"}`

## Map001:00004

原文：

```text
Yes
```

带保护符的原文：`Yes`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 3, "code": 102, "indent": 0, "branch_path": [], "choice": 0}`

## Map001:00005

原文：

```text
No
```

带保护符的原文：`No`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 3, "code": 102, "indent": 0, "branch_path": [], "choice": 1}`

## Map001:00006

原文：

```text
Clerk
```

带保护符的原文：`Clerk`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 5, "code": 101, "indent": 1, "branch_path": [{"type": "choice", "index": 0, "label": "Yes"}], "line_count": 1, "face": "", "speaker": "Clerk"}`

## Map001:00007

原文：

```text
Thank you.
```

带保护符的原文：`Thank you.`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 5, "code": 101, "indent": 1, "branch_path": [{"type": "choice", "index": 0, "label": "Yes"}], "line_count": 1, "face": "", "speaker": "Clerk"}`

## Map001:00008

原文：

```text
Clerk
```

带保护符的原文：`Clerk`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 8, "code": 101, "indent": 1, "branch_path": [{"type": "choice", "index": 1, "label": "No"}], "line_count": 1, "face": "", "speaker": "Clerk"}`

## Map001:00009

原文：

```text
Goodbye.
```

带保护符的原文：`Goodbye.`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 8, "code": 101, "indent": 1, "branch_path": [{"type": "choice", "index": 1, "label": "No"}], "line_count": 1, "face": "", "speaker": "Clerk"}`

## Map001:00010

原文：

```text
Lin
```

带保护符的原文：`Lin`

上下文：`{"map": "Map001", "event": 1, "page": 0, "x": 2, "y": 4, "command": 11, "code": 320, "indent": 0, "branch_path": [], "actor_id": 1}`

## System:00001

原文：

```text
Demo
```

带保护符的原文：`Demo`

上下文：`{"field": "gameTitle"}`

## System:00002

原文：

```text
Coin
```

带保护符的原文：`Coin`

上下文：`{"field": "currencyUnit"}`

## System:00003

原文：

```text
Fire
```

带保护符的原文：`Fire`

上下文：`{"field": "elements", "index": 1}`

## System:00004

原文：

```text
Level
```

带保护符的原文：`Level`

上下文：`{"field": "basic", "index": 0}`

## System:00005

原文：

```text
Fight
```

带保护符的原文：`Fight`

上下文：`{"field": "commands", "index": 0}`

## System:00006

原文：

```text
%1 wins!
```

带保护符的原文：`{{CTRL0001}} wins!`

上下文：`{"field": "messages", "index": "victory"}`
