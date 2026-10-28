# 本地模型接入

拼好汉化通过 OpenAI-compatible API 连接本地推理服务。模型在推理软件中加载，工作台填写
该软件的服务地址与实际模型名称，随后沿用同一套项目、文字协议和校验流程。

## 常用服务

| 推理软件 | 工作台接口地址示例 | 模型名称 |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | 已下载的名称，如 `qwen3:8b` |
| LM Studio | `http://127.0.0.1:1234/v1` | 本地服务列出的模型标识 |
| llama.cpp | `http://127.0.0.1:8080/v1` | 启动时的 `--alias` 或 `/v1/models` 返回值 |
| vLLM | `http://127.0.0.1:8000/v1` | `--served-model-name` 或实际模型路径标识 |

端口以推理软件实际设置为准。地址保留 `/v1`，工作台拼接 `/chat/completions`。
开放式本机服务的密钥可以留空；启用了鉴权时填写该服务的密钥。替换已有配置时，
建议为本地模型选用一个独立角色连接，再点击保存和测试连接。

本地运行建议先在 API 高级设置将并发设为 **1**，根据显存、内存和响应速度增加。
长场景需要充足的上下文窗口与输出空间；批次包含完整文字、相邻参考与术语表。

## 角色搭配

- 翻译与校对使用能稳定返回 JSON、保持 ID 与保护标记的文字模型。
- 技术角色使用支持工具调用的模型与服务。Qwen 服务端需要启用相应工具调用解析器。
- 图片处理使用视觉模型；纯文字本地模型用于文字阶段，图片处理可在设置中关闭。

三个角色可共用同一服务，也可各自连接不同模型。角色模型在“设置”的现有配置区选择。
连接测试检查 API 与 JSON 返回；正式任务继续检查逐条 ID、控制符、术语与原生回写。

## 已有实测

2026-10-18，以官方 **Qwen3-0.6B Q8_0** 和 **llama.cpp b11669 Windows CPU**
完成真实本机 HTTP 接入：空密钥连接、正式翻译任务 JSON、校对任务 JSON 均可返回。
该小模型在样例中出现错误译文，技术工具链也未能提交完整方案，适合连通性试验。
正式翻译请按实际样例挑选模型；本机资源允许时可尝试更大的 Qwen 指令模型。

本次测试关闭了服务端思考模式，监听地址为 `127.0.0.1`。模型和临时运行器保存在本机测试
目录，软件发行包保持原有大小。Ollama、LM Studio、vLLM 的协议说明依据其官方文档，
本次实测运行器为 llama.cpp。

## 官方资料

- [Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)
- [LM Studio OpenAI 兼容接口](https://lmstudio.ai/docs/developer/openai-compat)
- [Qwen 的 vLLM 部署与工具调用](https://qwen.readthedocs.io/en/stable/deployment/vllm.html)
- [llama.cpp 本地服务](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
