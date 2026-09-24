const BASE_URL = "https://api.commandcode.ai"

function toolOutput(output) {
  switch (output?.type) {
    case "text": return { type: "text", value: output.value }
    case "error-text": return { type: "error-text", value: output.value }
    case "json": return { type: "text", value: JSON.stringify(output.value) }
    case "error-json": return { type: "error-text", value: JSON.stringify(output.value) }
    case "execution-denied": return { type: "error-text", value: output.reason ?? "Execution denied" }
    case "content": return {
      type: "text",
      value: output.value.map((value) => typeof value?.text === "string" ? value.text : JSON.stringify(value)).join("\n"),
    }
    default: return { type: "text", value: JSON.stringify(output) }
  }
}

function convertMessage(message) {
  if (message.role === "user") {
    const content = []
    for (const part of message.content ?? []) {
      if (part.type === "text") content.push({ type: "text", text: part.text })
      else if (part.type === "file" && typeof part.data === "string" && part.mediaType?.startsWith("image/")) {
        content.push({ type: "image", image: part.data, mediaType: part.mediaType })
      } else if (part.type === "image") {
        const image = typeof part.image === "string"
          ? part.image
          : part.image instanceof URL ? part.image.toString()
          : part.image instanceof Uint8Array
            ? `data:${part.mediaType ?? "image/png"};base64,${Buffer.from(part.image).toString("base64")}`
            : undefined
        if (image) content.push({ type: "image", image, mediaType: part.mediaType })
      }
    }
    return { role: "user", content }
  }
  if (message.role === "assistant") {
    const content = []
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text) content.push({ type: "text", text: part.text })
      else if (part.type === "tool-call") {
        content.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
        })
      }
    }
    return { role: "assistant", content }
  }
  if (message.role === "tool") {
    const content = []
    for (const part of message.content ?? []) {
      if (part.type !== "tool-result") continue
      content.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: toolOutput(part.output),
      })
    }
    return { role: "tool", content }
  }
  return null
}

function convertTools(tools) {
  if (!tools) return []
  return tools.filter((tool) => tool.type === "function").map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

function buildRequest(modelID, options) {
  let system = ""
  const messages = []
  for (const message of options.prompt ?? []) {
    if (message.role === "system") {
      system += `${system ? "\n\n" : ""}${message.content}`
      continue
    }
    const converted = convertMessage(message)
    if (converted?.content?.length) messages.push(converted)
  }
  const providerOptions = options?.providerOptions?.commandcode
    ?? options?.providerOptions?.["opencode-commandcode-provider"]
    ?? options?.providerMetadata?.commandcode
    ?? {}
  const params = {
    model: modelID,
    system,
    messages,
    tools: convertTools(options.tools),
    max_tokens: options.maxOutputTokens ?? 65_536,
    stream: true,
  }
  if (options.temperature !== undefined) params.temperature = options.temperature
  if (options.topP !== undefined) params.top_p = options.topP
  if (options.topK !== undefined) params.top_k = options.topK
  if (providerOptions.thinking !== undefined) params.thinking = providerOptions.thinking
  if (typeof providerOptions.reasoningEffort === "string") params.reasoning_effort = providerOptions.reasoningEffort
  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: "production",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "standard",
    params,
  }
}

function mapFinishReason(raw) {
  if (raw === "stop" || raw === "end_turn") return "stop"
  if (raw === "tool_calls" || raw === "tool-calls") return "tool-calls"
  if (["length", "max_tokens", "max-tokens", "max_output_tokens"].includes(raw)) return "length"
  if (raw === "content_filter") return "content-filter"
  return "other"
}

function mapUsage(raw) {
  const inputDetails = raw?.inputTokenDetails ?? raw?.input_token_details ?? {}
  const outputDetails = raw?.outputTokenDetails ?? raw?.output_token_details ?? {}
  const cacheRead = raw?.cachedInputTokens ?? inputDetails.cacheReadTokens ?? raw?.raw?.prompt_cache_hit_tokens
  return {
    inputTokens: {
      total: raw?.inputTokens ?? raw?.prompt_tokens,
      noCache: inputDetails.noCacheTokens,
      cacheRead,
      cacheWrite: inputDetails.cacheWriteTokens,
    },
    outputTokens: {
      total: raw?.outputTokens ?? raw?.completion_tokens,
      text: outputDetails.textTokens,
      reasoning: outputDetails.reasoningTokens,
    },
  }
}

function streamParts(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const newline = buffer.indexOf("\n")
          if (newline >= 0) {
            let line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line || line.startsWith(":") || line === "[DONE]") continue
            if (line.startsWith("data:")) line = line.slice(5).trim()
            if (!line || line === "[DONE]") continue
            let event
            try { event = JSON.parse(line) } catch { continue }
            if (!event || typeof event.type !== "string") continue
            if (event.type === "error") {
              controller.error(new Error(event?.error?.message ?? event?.message ?? "Command Code stream error"))
              return
            }
            let part = null
            switch (event.type) {
              case "start": part = { type: "stream-start", warnings: [] }; break
              case "text-start": part = { type: "text-start", id: event.id }; break
              case "text-delta": part = { type: "text-delta", id: event.id, delta: event.text ?? event.delta ?? "" }; break
              case "text-end": part = { type: "text-end", id: event.id }; break
              case "reasoning-start": part = { type: "reasoning-start", id: event.id }; break
              case "reasoning-delta": part = { type: "reasoning-delta", id: event.id, delta: event.text ?? event.delta ?? "" }; break
              case "reasoning-end": part = { type: "reasoning-end", id: event.id }; break
              case "tool-input-start": part = { type: "tool-input-start", id: event.id ?? event.toolCallId, toolName: event.toolName ?? event.name ?? "" }; break
              case "tool-input-delta": part = { type: "tool-input-delta", id: event.id ?? event.toolCallId, delta: event.delta ?? "" }; break
              case "tool-input-end": part = { type: "tool-input-end", id: event.id ?? event.toolCallId }; break
              case "tool-call": {
                const input = event.input ?? event.args ?? event.arguments ?? {}
                part = {
                  type: "tool-call",
                  toolCallId: event.toolCallId ?? event.id ?? "",
                  toolName: event.toolName ?? event.name ?? "",
                  input: typeof input === "string" ? input : JSON.stringify(input),
                }
                break
              }
              case "finish-step": {
                const rawReason = event.finishReason ?? event.rawFinishReason ?? "stop"
                part = {
                  type: "finish",
                  finishReason: { unified: mapFinishReason(rawReason), raw: rawReason },
                  usage: mapUsage(event.usage ?? event.totalUsage ?? {}),
                }
                break
              }
            }
            if (part) {
              controller.enqueue(part)
              return
            }
            continue
          }
          const next = await reader.read()
          if (next.done) {
            if (buffer.trim()) buffer += "\n"
            else {
              controller.close()
              return
            }
          } else {
            buffer += decoder.decode(next.value, { stream: true })
          }
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() { reader.cancel() },
  })
}

class CommandCodeLanguageModel {
  specificationVersion = "v3"
  provider = "commandcode"
  supportedUrls = {}

  constructor(modelID, options) {
    this.modelId = modelID
    this.options = options
  }

  async doStream(options) {
    const apiKey = typeof this.options.apiKey === "function"
      ? await this.options.apiKey()
      : this.options.apiKey ?? process.env.COMMANDCODE_API_KEY
    if (!apiKey) throw new Error("Command Code API key not found. Use /connect or set COMMANDCODE_API_KEY.")
    const requestBody = JSON.stringify(buildRequest(this.modelId, options))
    const commandCodeVersion = typeof this.options.commandCodeVersion === "function"
      ? this.options.commandCodeVersion()
      : this.options.commandCodeVersion
    const response = await fetch(`${this.options.baseURL ?? BASE_URL}/alpha/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        "x-cli-environment": "production",
        ...(commandCodeVersion ? { "x-command-code-version": commandCodeVersion } : {}),
        "x-session-id": crypto.randomUUID(),
        ...(process.env.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : {}),
        ...this.options.headers,
      },
      body: requestBody,
      signal: options.abortSignal,
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Command Code ${response.status}: ${detail || response.statusText}`)
    }
    const headers = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    return { stream: streamParts(response.body), request: { body: requestBody }, response: { headers } }
  }

  async doGenerate(options) {
    const { stream } = await this.doStream(options)
    const text = []
    const reasoning = []
    const content = []
    let finishReason = { unified: "stop", raw: "stop" }
    let usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === "text-delta") text.push(value.delta)
      else if (value.type === "reasoning-delta") reasoning.push(value.delta)
      else if (value.type === "tool-call") content.push({
        type: "tool-call",
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        input: value.input,
      })
      else if (value.type === "finish") {
        finishReason = value.finishReason
        usage = value.usage
      }
    }
    if (text.length) content.unshift({ type: "text", text: text.join("") })
    if (reasoning.length) content.unshift({ type: "reasoning", text: reasoning.join("") })
    return { content, finishReason, usage, warnings: [] }
  }
}

export function createCommandCode(options = {}) {
  return {
    languageModel(modelID) {
      return new CommandCodeLanguageModel(modelID, options)
    },
  }
}

export default createCommandCode
