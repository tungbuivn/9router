// Generate Zed `language_models.openai_compatible.<id>.available_models` from 9Router.
// Zed's openai_compatible provider does NOT auto-discover models, so paste this output
// into ~/.config/zed/settings.json (or %APPDATA%\Zed\settings.json on Windows).
//
// Usage: node zed-models.mjs [baseUrl] [filter]
//   node zed-models.mjs http://127.0.0.1:20127
//   node zed-models.mjs http://127.0.0.1:20128 combo
const baseUrl = (process.argv[2] || "http://127.0.0.1:20127").replace(/\/+$/, "");
const filter = (process.argv[3] || "").toLowerCase();

const res = await fetch(`${baseUrl}/v1/models`);
if (!res.ok) {
  console.error(`GET ${baseUrl}/v1/models -> HTTP ${res.status}`);
  process.exit(1);
}
const payload = await res.json();
const all = payload.data || payload.models || [];
const models = filter ? all.filter((m) => String(m.id).toLowerCase().includes(filter)) : all;

const available_models = models.map((m) => {
  const caps = m.capabilities || {};
  return {
    name: m.id,
    display_name: m.id,
    max_tokens: caps.contextWindow || m.context_length || 128000,
    max_output_tokens: caps.maxOutput || m.max_completion_tokens || 64000,
    capabilities: {
      tools: caps.tools !== false,
      images: caps.vision === true,
      parallel_tool_calls: caps.tools !== false,
      prompt_cache_key: true,
      chat_completions: true,
      interleaved_reasoning: false,
      max_tokens_parameter: false,
    },
  };
});

console.error(`# ${available_models.length}/${all.length} models from ${baseUrl}`);
console.log(JSON.stringify(available_models, null, 2));
