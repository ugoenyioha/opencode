#!/usr/bin/env bun

type Result = {
  name: string
  ok: boolean
  detail: string
}

const base = process.env.OPENAI_COMPAT_BASE_URL || "https://colesclaw.usableapps.local"
const token = process.env.OPENAI_COMPAT_BEARER || process.env.OPENCODE_TOOL_ENDPOINT_API_KEY || ""
const model = process.env.OPENAI_COMPAT_MODEL || "openai/gpt-5.4"

if (!token) {
  console.error("Missing OPENAI_COMPAT_BEARER or OPENCODE_TOOL_ENDPOINT_API_KEY")
  process.exit(1)
}

const auth = { Authorization: `Bearer ${token}` }

async function text(res: Response) {
  const body = await res.text()
  return { status: res.status, body, type: res.headers.get("content-type") || "" }
}

function ok(name: string, detail: string): Result {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): Result {
  return { name, ok: false, detail }
}

async function models() {
  const res = await fetch(`${base}/v1/models`, { headers: auth })
  const out = await text(res)
  if (out.status !== 200) return fail("models", `${out.status} ${out.body}`)
  const data = JSON.parse(out.body)
  if (!Array.isArray(data.data)) return fail("models", `missing data array: ${out.body}`)
  const found = data.data.some((item: any) => item.id === model)
  return found ? ok("models", `found ${model}`) : fail("models", `${model} not listed`)
}

async function chat() {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Say hello in one sentence." }],
    }),
  })
  const out = await text(res)
  if (out.status !== 200) return fail("chat", `${out.status} ${out.body}`)
  const data = JSON.parse(out.body)
  const msg = data?.choices?.[0]?.message?.content
  return typeof msg === "string" && msg.trim() ? ok("chat", msg.trim()) : fail("chat", out.body)
}

async function responses() {
  const res = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: "Say hello in one sentence.",
    }),
  })
  const out = await text(res)
  if (out.status !== 200) return fail("responses", `${out.status} ${out.body}`)
  const data = JSON.parse(out.body)
  const textPart = data?.output?.[0]?.content?.find?.((item: any) => item.type === "output_text")?.text
  return typeof textPart === "string" && textPart.trim()
    ? ok("responses", textPart.trim())
    : fail("responses", out.body)
}

function sse(body: string) {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice(6))
}

async function streamChat() {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: "Say hello in one sentence." }],
    }),
  })
  const out = await text(res)
  if (out.status !== 200) return fail("stream-chat", `${out.status} ${out.body}`)
  const chunks = sse(out.body)
  if (!chunks.length) return fail("stream-chat", "no SSE data")
  if (chunks.at(-1) !== "[DONE]") return fail("stream-chat", `missing [DONE]: ${out.body}`)
  const parsed = chunks.slice(0, -1).map((item) => JSON.parse(item))
  const hasRole = parsed.some((item) => item?.choices?.[0]?.delta?.role === "assistant")
  const content = parsed
    .map((item) => item?.choices?.[0]?.delta?.content || "")
    .join("")
    .trim()
  if (!hasRole) return fail("stream-chat", `missing assistant role chunk: ${out.body}`)
  if (!content) return fail("stream-chat", `missing content delta: ${out.body}`)
  return ok("stream-chat", content)
}

async function streamResponses() {
  const res = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      input: "Say hello in one sentence.",
    }),
  })
  const out = await text(res)
  if (out.status !== 200) return fail("stream-responses", `${out.status} ${out.body}`)
  const chunks = sse(out.body)
  if (!chunks.length) return fail("stream-responses", "no SSE data")
  if (chunks.at(-1) !== "[DONE]") return fail("stream-responses", `missing [DONE]: ${out.body}`)
  const parsed = chunks.slice(0, -1).map((item) => JSON.parse(item))
  const delta = parsed
    .filter((item) => item?.type === "response.output_text.delta")
    .map((item) => item.delta || "")
    .join("")
    .trim()
  const completed = parsed.some((item) => item?.type === "response.completed")
  if (!completed) return fail("stream-responses", `missing response.completed: ${out.body}`)
  if (!delta) return fail("stream-responses", `missing output_text delta: ${out.body}`)
  return ok("stream-responses", delta)
}

const results = await Promise.all([models(), chat(), responses(), streamChat(), streamResponses()])
for (const item of results) {
  const mark = item.ok ? "PASS" : "FAIL"
  console.log(`${mark} ${item.name}: ${item.detail}`)
}

if (results.some((item) => !item.ok)) process.exit(1)
