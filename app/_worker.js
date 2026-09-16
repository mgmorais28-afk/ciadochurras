// Servidor do CiadoChurras (Cloudflare Pages — modo avançado).
//
// Por que um arquivo só: o deploy por arrastar a pasta no painel do Cloudflare NÃO compila
// uma pasta "functions/" — ela subiria como arquivo estático e as rotas não existiriam.
// Um "_worker.js" na raiz, por outro lado, funciona tanto no arrastar-e-soltar quanto no wrangler.
//
// Precisa, no projeto do Pages:
//   - binding de R2 chamado BASE, apontando para o bucket precos-carnes
//   - variável secreta CHAVE_ADMIN (libera o painel de aprovação)
//
// Rotas:
//   GET  /api/ping            o app pergunta se o envio de correções está no ar
//   POST /api/envios          recebe correção de preço / produto novo (foto obrigatória)
//   GET  /api/admin/pendentes lista o que espera aprovação            (exige a chave)
//   GET  /api/admin/historico aprovados e recusados                   (exige a chave)
//   POST /api/admin/aprovar   publica o ajuste                        (exige a chave)
//   POST /api/admin/recusar   descarta e apaga a foto                 (exige a chave)
//   POST /api/admin/remover   tira do ar um ajuste publicado          (exige a chave)
//   GET  /fotos/<arquivo>     foto da etiqueta                        (exige a chave)
//   GET  /dados/<arquivo>     preços do dia e ajustes aprovados
//   qualquer outra coisa      arquivo estático do site (index.html, admin.html, ícones…)

const CAMINHO_AJUSTES = "envios/ajustes.json";
const DIAS_VALIDADE = 60;           // depois disso um ajuste aprovado sai do ar sozinho
const MAX_FOTO = 6 * 1024 * 1024;   // 6 MB por foto já reduzida no aparelho
const MAX_PENDENTES = 300;          // trava simples contra enxurrada de envios
const TIPOS_FOTO = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// ---------------------------------------------------------------- utilidades

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function chaveConfere(request, env) {
  const esperada = (env.CHAVE_ADMIN || "").trim();
  if (!esperada) return false;
  const recebida = (request.headers.get("x-chave") || "").trim();
  if (recebida.length !== esperada.length) return false;
  let dif = 0;
  for (let i = 0; i < esperada.length; i++) dif |= esperada.charCodeAt(i) ^ recebida.charCodeAt(i);
  return dif === 0;
}

function texto(v, max) {
  return String(v == null ? "" : v)
    .split("")
    .filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function numero(v) {
  const limpo = String(v == null ? "" : v).replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = Date.parse(s + "T12:00:00Z");
  if (!Number.isFinite(d)) return false;
  const agora = Date.now();
  return d <= agora + 86400000 && d >= agora - 10 * 86400000;
}

function novoId() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 8);
}

const idValido = id => typeof id === "string" && /^[A-Za-z0-9-]{10,64}$/.test(id);

async function lerAjustes(env) {
  const o = await env.BASE.get(CAMINHO_AJUSTES);
  if (!o) return { gerado_em: "", correcoes: [], novos: [] };
  try {
    const j = await o.json();
    return { gerado_em: j.gerado_em || "", correcoes: j.correcoes || [], novos: j.novos || [] };
  } catch (e) {
    return { gerado_em: "", correcoes: [], novos: [] };
  }
}

async function gravarAjustes(env, aj) {
  const limite = Date.now() - DIAS_VALIDADE * 86400000;
  const vivo = x => {
    const t = Date.parse(x.aprovado_em || (x.data ? x.data + "T12:00:00Z" : ""));
    return !Number.isFinite(t) || t >= limite;
  };
  const saida = {
    gerado_em: new Date().toISOString(),
    correcoes: (aj.correcoes || []).filter(vivo),
    novos: (aj.novos || []).filter(vivo)
  };
  await env.BASE.put(CAMINHO_AJUSTES, JSON.stringify(saida), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  return saida;
}

async function lerLista(env, prefixo) {
  const lista = await env.BASE.list({ prefix: prefixo, limit: 400 });
  const itens = [];
  for (const o of lista.objects) {
    const obj = await env.BASE.get(o.key);
    if (!obj) continue;
    try { itens.push(await obj.json()); } catch (e) { /* arquivo estranho: ignora */ }
  }
  itens.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
  return itens;
}

// ------------------------------------------------------------------- envios

async function marcaDeOrigem(request) {
  // guarda só um resumo do IP, para reconhecer envios repetidos sem gravar o endereço
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!ip) return "";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("clube-churrasco:" + ip));
  return [...new Uint8Array(hash)].slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function receberEnvio(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ ok: false, erro: "Não consegui ler o envio. Tente de novo." }, 400);
  }

  const tipo = texto(form.get("tipo"), 10);
  if (tipo !== "correcao" && tipo !== "novo") return json({ ok: false, erro: "Tipo de envio inválido." }, 400);

  const foto = form.get("foto");
  if (!foto || typeof foto === "string" || !foto.size) {
    return json({ ok: false, erro: "A foto da etiqueta é obrigatória." }, 400);
  }
  if (foto.size > MAX_FOTO) return json({ ok: false, erro: "A foto ficou grande demais. Tire outra." }, 413);
  const ext = TIPOS_FOTO[foto.type];
  if (!ext) return json({ ok: false, erro: "Envie a foto em JPEG, PNG ou WebP." }, 415);

  const preco = numero(form.get("preco"));
  if (!Number.isFinite(preco) || preco < 0.05 || preco > 9999) {
    return json({ ok: false, erro: "Preço fora do esperado. Confira o valor da etiqueta." }, 400);
  }
  const unidade = texto(form.get("unidade"), 2);
  if (unidade !== "kg" && unidade !== "un") return json({ ok: false, erro: "Unidade inválida." }, 400);

  const data = texto(form.get("data"), 10);
  if (!dataValida(data)) return json({ ok: false, erro: "A data da etiqueta precisa ser de hoje ou dos últimos dias." }, 400);

  const envio = {
    id: novoId(),
    tipo,
    criado_em: new Date().toISOString(),
    mercado: texto(form.get("mercado"), 40),
    loja: texto(form.get("loja"), 160),
    categoria: texto(form.get("categoria"), 40),
    produto: texto(form.get("produto"), 140),
    sku: texto(form.get("sku"), 32),
    preco,
    unidade,
    preco_site: numero(form.get("preco_site")),
    data_coleta: texto(form.get("data_coleta"), 10),
    data,
    por: texto(form.get("por"), 40),
    obs: texto(form.get("obs"), 300),
    origem: await marcaDeOrigem(request),
    status: "pendente"
  };
  if (!Number.isFinite(envio.preco_site)) delete envio.preco_site;

  if (envio.produto.length < 3) return json({ ok: false, erro: "Escreva o nome do produto." }, 400);
  if (envio.loja.length < 3) return json({ ok: false, erro: "Escolha a loja." }, 400);
  if (tipo === "novo" && (envio.mercado.length < 2 || envio.categoria.length < 2)) {
    return json({ ok: false, erro: "Escolha o mercado e o tipo de carne." }, 400);
  }

  const pendentes = await env.BASE.list({ prefix: "envios/pendentes/", limit: MAX_PENDENTES + 1 });
  if (pendentes.objects.length > MAX_PENDENTES) {
    return json({ ok: false, erro: "Há envios demais esperando aprovação. Tente mais tarde." }, 429);
  }

  envio.foto = "envios/fotos/" + envio.id + "." + ext;
  await env.BASE.put(envio.foto, foto.stream(), { httpMetadata: { contentType: foto.type } });
  await env.BASE.put("envios/pendentes/" + envio.id + ".json", JSON.stringify(envio), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });

  return json({ ok: true, id: envio.id, pendentes: pendentes.objects.length + 1 });
}

// -------------------------------------------------------- painel de aprovação

async function painelAdmin(request, env, rota) {
  if (!(env.CHAVE_ADMIN || "").trim()) {
    return json({ ok: false, erro: "Falta definir a variável CHAVE_ADMIN no projeto do Cloudflare Pages." }, 503);
  }
  if (!chaveConfere(request, env)) return json({ ok: false, erro: "Chave inválida." }, 401);

  // cadastro de estabelecimentos parceiros
  if (rota.startsWith("parceiros")) {
    let corpoAdmin = {};
    if (request.method === "POST") { try { corpoAdmin = await request.json(); } catch (e) { corpoAdmin = {}; } }
    const resp = await adminParceiros(request, env, rota, corpoAdmin);
    if (resp) return resp;
    return json({ ok: false, erro: "Rota não encontrada." }, 404);
  }

  if (request.method === "GET" && (rota === "" || rota === "pendentes")) {
    return json({ ok: true, pendentes: await lerLista(env, "envios/pendentes/"), ajustes: await lerAjustes(env) });
  }
  if (request.method === "GET" && rota === "historico") {
    return json({ ok: true, aprovados: await lerLista(env, "envios/aprovados/"), recusados: await lerLista(env, "envios/recusados/") });
  }
  if (request.method !== "POST") return json({ ok: false, erro: "Rota não encontrada." }, 404);

  let dados = {};
  try { dados = await request.json(); } catch (e) { dados = {}; }

  if (rota === "aprovar" || rota === "recusar") {
    const id = texto(dados.id, 64);
    if (!idValido(id)) return json({ ok: false, erro: "Envio inválido." }, 400);
    const obj = await env.BASE.get("envios/pendentes/" + id + ".json");
    if (!obj) return json({ ok: false, erro: "Esse envio não está mais pendente." }, 404);
    const envio = await obj.json();

    if (rota === "recusar") {
      envio.status = "recusado";
      envio.motivo = texto(dados.motivo, 200);
      envio.decidido_em = new Date().toISOString();
      await env.BASE.put("envios/recusados/" + id + ".json", JSON.stringify(envio), {
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      });
      await env.BASE.delete("envios/pendentes/" + id + ".json");
      if (envio.foto) await env.BASE.delete(envio.foto);   // foto recusada não ocupa espaço
      return json({ ok: true, status: "recusado" });
    }

    envio.status = "aprovado";
    envio.decidido_em = new Date().toISOString();
    const aj = await lerAjustes(env);
    const registro = {
      id: envio.id, mercado: envio.mercado, loja: envio.loja, categoria: envio.categoria,
      produto: envio.produto, sku: envio.sku, preco: envio.preco, unidade: envio.unidade,
      data: envio.data, por: envio.por, obs: envio.obs, aprovado_em: envio.decidido_em
    };
    if (envio.tipo === "correcao") {
      if (typeof envio.preco_site === "number") registro.preco_site = envio.preco_site;
      const mesmoAlvo = c => c.loja === registro.loja && (registro.sku ? c.sku === registro.sku : c.produto === registro.produto);
      aj.correcoes = aj.correcoes.filter(c => !mesmoAlvo(c));
      aj.correcoes.push(registro);
    } else {
      aj.novos = aj.novos.filter(n => n.id !== registro.id);
      aj.novos.push(registro);
    }
    const publicado = await gravarAjustes(env, aj);
    await env.BASE.put("envios/aprovados/" + id + ".json", JSON.stringify(envio), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    await env.BASE.delete("envios/pendentes/" + id + ".json");
    return json({ ok: true, status: "aprovado", ajustes: publicado });
  }

  if (rota === "remover") {
    const id = texto(dados.id, 64);
    if (!idValido(id)) return json({ ok: false, erro: "Ajuste inválido." }, 400);
    const aj = await lerAjustes(env);
    const antes = aj.correcoes.length + aj.novos.length;
    aj.correcoes = aj.correcoes.filter(c => c.id !== id);
    aj.novos = aj.novos.filter(n => n.id !== id);
    if (antes === aj.correcoes.length + aj.novos.length) {
      return json({ ok: false, erro: "Esse ajuste já não está publicado." }, 404);
    }
    return json({ ok: true, ajustes: await gravarAjustes(env, aj) });
  }

  return json({ ok: false, erro: "Rota não encontrada." }, 404);
}

// ---------------------------------------------------------- fotos e dados

async function entregarFoto(request, env, nome) {
  if (!chaveConfere(request, env)) return json({ ok: false, erro: "Chave inválida." }, 401);
  if (!/^[A-Za-z0-9-]{10,64}\.(jpg|png|webp)$/.test(nome)) return json({ ok: false, erro: "Foto inválida." }, 400);
  const obj = await env.BASE.get("envios/fotos/" + nome);
  if (!obj) return json({ ok: false, erro: "Foto não encontrada." }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg",
      "cache-control": "private, max-age=600"
    }
  });
}

async function entregarDados(request, env, caminho) {
  const alvo = caminho || "latest.json";
  const chave = alvo === "ajustes.json" ? CAMINHO_AJUSTES
    : alvo === "parceiros.json" ? PUBLICADO
    : "dados/" + alvo;
  const objeto = await env.BASE.get(chave);

  if (!objeto) {
    // ainda não houve nenhuma correção aprovada: devolve a camada vazia
    if (alvo === "ajustes.json" || alvo === "parceiros.json") {
      const vazio = alvo === "parceiros.json" ? { gerado_em: "", produtos: [] } : { gerado_em: "", correcoes: [], novos: [] };
      return new Response(JSON.stringify(vazio), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return new Response("não encontrado: " + alvo, { status: 404 });
  }

  const etag = objeto.httpEtag;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });

  return new Response(objeto.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": (alvo === "ajustes.json" || alvo === "parceiros.json") ? "public, max-age=60" : "public, max-age=300",
      etag
    }
  });
}

// ----------------------------------------------- estabelecimentos parceiros
// Contas de estabelecimento: o admin cadastra, o responsável entra com e-mail e senha
// e publica os próprios produtos. A senha nunca é guardada em texto — só o hash PBKDF2.

const CONTAS = "parceiros/contas/";        // parceiros/contas/<id>.json
const PRODUTOS = "parceiros/produtos/";    // parceiros/produtos/<id>.json (lista)
const PUBLICADO = "parceiros/publicado.json";
const MAX_PARCEIROS = 300;
const MAX_PRODUTOS = 300;                  // por estabelecimento
const DIAS_SESSAO = 30;
const CATEGORIAS = ["Carne Bovina", "Carne Suína", "Aves", "Linguiças", "Ovinos", "Kits"];

const codif = new TextEncoder();

function b64url(buf) {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deB64url(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
function mesmoTexto(a, b) {   // comparação de tempo constante
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}
function novoSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return b64url(a);
}
// O plano gratuito do Cloudflare dá 10 ms de CPU por requisição, e PBKDF2 com 120 mil
// iterações gasta ~22 ms — o Worker morria no meio e devolvia 500. Com 10 mil iterações
// o hash sai em ~2 ms, e a "pimenta" (a CHAVE_ADMIN, que só existe no servidor) entra na
// mistura: um vazamento do bucket sozinho não dá para testar senha nenhuma.
const ITERACOES = 10000;

async function hashSenha(senha, salt, env) {
  const pimenta = (env && env.CHAVE_ADMIN) || "";
  const chave = await crypto.subtle.importKey("raw", codif.encode(senha + "\u0000" + pimenta), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: deB64url(salt), iterations: ITERACOES, hash: "SHA-256" }, chave, 256);
  return b64url(bits);
}

// sessão do parceiro: corpo assinado com HMAC derivado da chave do admin
async function assinar(env, txt) {
  const chave = await crypto.subtle.importKey("raw", codif.encode("sessao-parceiro:" + (env.CHAVE_ADMIN || "")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", chave, codif.encode(txt)));
}
async function criarToken(env, id) {
  const corpo = b64url(codif.encode(JSON.stringify({ id, exp: Date.now() + DIAS_SESSAO * 86400000 })));
  return corpo + "." + (await assinar(env, corpo));
}
async function lerToken(env, token) {
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [corpo, assinatura] = token.split(".");
  if (!mesmoTexto(assinatura || "", await assinar(env, corpo))) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(deB64url(corpo)));
    return o && o.id && o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}

const emailValido = e => /^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$/.test(e);
const semSenha = c => { const { hash, salt, ...resto } = c; return resto; };

async function listarContas(env) {
  const lista = await env.BASE.list({ prefix: CONTAS, limit: MAX_PARCEIROS });
  const contas = [];
  for (const o of lista.objects) {
    const obj = await env.BASE.get(o.key);
    if (!obj) continue;
    try { contas.push(await obj.json()); } catch (e) { /* arquivo estranho: ignora */ }
  }
  contas.sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
  return contas;
}
async function lerConta(env, id) {
  const o = await env.BASE.get(CONTAS + id + ".json");
  if (!o) return null;
  try { return await o.json(); } catch (e) { return null; }
}
const gravarConta = (env, c) => env.BASE.put(CONTAS + c.id + ".json", JSON.stringify(c),
  { httpMetadata: { contentType: "application/json; charset=utf-8" } });

async function lerProdutos(env, id) {
  const o = await env.BASE.get(PRODUTOS + id + ".json");
  if (!o) return [];
  try { const j = await o.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}
const gravarProdutos = (env, id, lista) => env.BASE.put(PRODUTOS + id + ".json", JSON.stringify(lista),
  { httpMetadata: { contentType: "application/json; charset=utf-8" } });

// refaz o arquivo que o app lê: só estabelecimentos ativos e produtos ativos
async function republicar(env) {
  const contas = await listarContas(env);
  const produtos = [];
  for (const c of contas) {
    if (c.status !== "ativo") continue;
    const meus = await lerProdutos(env, c.id);
    for (const p of meus) {
      if (p.ativo === false) continue;
      produtos.push({
        id: c.id + ":" + p.id,
        mercado: c.nome,
        loja: c.bairro || c.cidade || "loja única",
        categoria: p.categoria,
        produto: p.nome,
        descricao: p.descricao || "",
        preco: p.preco,
        unidade: p.unidade,
        atualizado_em: p.atualizado_em || c.criado_em
      });
    }
  }
  const saida = { gerado_em: new Date().toISOString(), produtos };
  await env.BASE.put(PUBLICADO, JSON.stringify(saida),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return saida;
}

// ---------------------------------------------- rotas do admin (exigem chave)
async function adminParceiros(request, env, rota, dados) {
  if (request.method === "GET" && rota === "parceiros") {
    const contas = await listarContas(env);
    const fora = [];
    for (const c of contas) {
      const meus = await lerProdutos(env, c.id);
      fora.push(Object.assign(semSenha(c), {
        produtos: meus.length,
        produtos_ativos: meus.filter(p => p.ativo !== false).length
      }));
    }
    return json({ ok: true, parceiros: fora });
  }

  if (request.method === "GET" && rota.startsWith("parceiros/produtos/")) {
    const id = texto(rota.slice("parceiros/produtos/".length), 64);
    const conta = idValido(id) ? await lerConta(env, id) : null;
    if (!conta) return json({ ok: false, erro: "Estabelecimento não encontrado." }, 404);
    return json({ ok: true, parceiro: semSenha(conta), produtos: await lerProdutos(env, id) });
  }

  if (request.method !== "POST") return null;

  if (rota === "parceiros/criar") {
    const nome = texto(dados.nome, 60);
    const responsavel = texto(dados.responsavel, 60);
    const email = texto(dados.email, 120).toLowerCase();
    const senha = String(dados.senha == null ? "" : dados.senha);
    if (nome.length < 2) return json({ ok: false, erro: "Escreva o nome do estabelecimento." }, 400);
    if (responsavel.length < 2) return json({ ok: false, erro: "Escreva o nome do responsável." }, 400);
    if (!emailValido(email)) return json({ ok: false, erro: "E-mail inválido." }, 400);
    if (senha.length < 6 || senha.length > 72) return json({ ok: false, erro: "A senha precisa ter de 6 a 72 caracteres." }, 400);

    const contas = await listarContas(env);
    if (contas.length >= MAX_PARCEIROS) return json({ ok: false, erro: "Limite de estabelecimentos atingido." }, 429);
    if (contas.some(c => c.email === email)) return json({ ok: false, erro: "Já existe um estabelecimento com esse e-mail." }, 409);

    const salt = novoSalt();
    const conta = {
      id: "par-" + novoId(),
      nome, responsavel, email,
      telefone: texto(dados.telefone, 30),
      bairro: texto(dados.bairro, 60),
      cidade: texto(dados.cidade, 60) || "Curitiba",
      status: "ativo",
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
      ultimo_acesso: "",
      algo: "pbkdf2-" + ITERACOES + "-pimenta",
      salt, hash: await hashSenha(senha, salt, env)
    };
    await gravarConta(env, conta);
    await republicar(env);
    return json({ ok: true, parceiro: semSenha(conta) });
  }

  const id = texto(dados.id, 64);
  if (!idValido(id)) return json({ ok: false, erro: "Estabelecimento inválido." }, 400);
  const conta = await lerConta(env, id);
  if (!conta) return json({ ok: false, erro: "Estabelecimento não encontrado." }, 404);

  if (rota === "parceiros/senha") {
    const senha = String(dados.senha == null ? "" : dados.senha);
    if (senha.length < 6 || senha.length > 72) return json({ ok: false, erro: "A senha precisa ter de 6 a 72 caracteres." }, 400);
    conta.salt = novoSalt();
    conta.hash = await hashSenha(senha, conta.salt, env);
    conta.atualizado_em = new Date().toISOString();
    await gravarConta(env, conta);
    return json({ ok: true, parceiro: semSenha(conta) });
  }

  if (rota === "parceiros/status") {
    const status = texto(dados.status, 10);
    if (status !== "ativo" && status !== "suspenso") return json({ ok: false, erro: "Situação inválida." }, 400);
    conta.status = status;
    conta.atualizado_em = new Date().toISOString();
    await gravarConta(env, conta);
    const pub = await republicar(env);
    return json({ ok: true, parceiro: semSenha(conta), publicados: pub.produtos.length });
  }

  if (rota === "parceiros/excluir") {
    await env.BASE.delete(CONTAS + id + ".json");
    await env.BASE.delete(PRODUTOS + id + ".json");
    const pub = await republicar(env);
    return json({ ok: true, publicados: pub.produtos.length });
  }

  return null;   // não é rota de parceiro: o painel de aprovação continua o tratamento
}

// ------------------------------------------- rotas do próprio estabelecimento
async function contaDaSessao(request, env) {
  const o = await lerToken(env, request.headers.get("x-parceiro") || "");
  if (!o) return null;
  const conta = await lerConta(env, o.id);
  if (!conta || conta.status !== "ativo") return null;
  return conta;
}

async function areaDoParceiro(request, env, rota) {
  let dados = {};
  if (request.method === "POST") { try { dados = await request.json(); } catch (e) { dados = {}; } }

  if (rota === "login") {
    if (request.method !== "POST") return json({ ok: false, erro: "Rota não encontrada." }, 404);
    const email = texto(dados.email, 120).toLowerCase();
    const senha = String(dados.senha == null ? "" : dados.senha);
    const contas = await listarContas(env);
    const conta = contas.find(c => c.email === email);
    const confere = conta ? mesmoTexto(conta.hash, await hashSenha(senha, conta.salt, env)) : false;
    if (!conta || !confere) {
      await new Promise(r => setTimeout(r, 400));   // atrasa tentativa errada
      return json({ ok: false, erro: "E-mail ou senha não conferem." }, 401);
    }
    if (conta.status !== "ativo") return json({ ok: false, erro: "Este cadastro está suspenso. Fale com o administrador." }, 403);
    conta.ultimo_acesso = new Date().toISOString();
    await gravarConta(env, conta);
    return json({ ok: true, token: await criarToken(env, conta.id), parceiro: semSenha(conta), categorias: CATEGORIAS });
  }

  const conta = await contaDaSessao(request, env);
  if (!conta) return json({ ok: false, erro: "Sessão expirada. Entre de novo." }, 401);

  if (rota === "eu" && request.method === "GET") {
    return json({ ok: true, parceiro: semSenha(conta), produtos: await lerProdutos(env, conta.id), categorias: CATEGORIAS });
  }

  if (rota === "produto" && request.method === "POST") {
    const nome = texto(dados.nome, 120);
    const categoria = texto(dados.categoria, 30);
    const descricao = texto(dados.descricao, 400);
    const unidade = texto(dados.unidade, 2);
    const preco = numero(dados.preco);
    if (nome.length < 3) return json({ ok: false, erro: "Escreva o nome do produto." }, 400);
    if (CATEGORIAS.indexOf(categoria) < 0) return json({ ok: false, erro: "Categoria inválida." }, 400);
    if (unidade !== "kg" && unidade !== "un") return json({ ok: false, erro: "Unidade inválida." }, 400);
    if (!Number.isFinite(preco) || preco < 0.05 || preco > 99999) return json({ ok: false, erro: "Preço fora do esperado." }, 400);
    if (categoria === "Kits" && descricao.length < 5) {
      return json({ ok: false, erro: "No kit, descreva o que vai dentro (ex.: 1 picanha + pão de alho + pack de cerveja)." }, 400);
    }

    const lista = await lerProdutos(env, conta.id);
    const idProd = texto(dados.id, 64);
    const agora = new Date().toISOString();
    let p = idProd ? lista.find(x => x.id === idProd) : null;
    if (idProd && !p) return json({ ok: false, erro: "Produto não encontrado." }, 404);
    if (!p) {
      if (lista.length >= MAX_PRODUTOS) return json({ ok: false, erro: "Limite de produtos atingido." }, 429);
      p = { id: "prd-" + novoId(), criado_em: agora };
      lista.push(p);
    }
    Object.assign(p, {
      nome, categoria, descricao, preco, unidade,
      ativo: dados.ativo !== false,
      atualizado_em: agora
    });
    await gravarProdutos(env, conta.id, lista);
    const pub = await republicar(env);
    return json({ ok: true, produto: p, produtos: lista, publicados: pub.produtos.length });
  }

  if (rota === "produto/remover" && request.method === "POST") {
    const idProd = texto(dados.id, 64);
    const lista = await lerProdutos(env, conta.id);
    const fora = lista.filter(x => x.id !== idProd);
    if (fora.length === lista.length) return json({ ok: false, erro: "Produto não encontrado." }, 404);
    await gravarProdutos(env, conta.id, fora);
    await republicar(env);
    return json({ ok: true, produtos: fora });
  }

  if (rota === "senha" && request.method === "POST") {
    const atual = String(dados.atual == null ? "" : dados.atual);
    const nova = String(dados.nova == null ? "" : dados.nova);
    if (!mesmoTexto(conta.hash, await hashSenha(atual, conta.salt, env))) {
      await new Promise(r => setTimeout(r, 400));
      return json({ ok: false, erro: "A senha atual não confere." }, 401);
    }
    if (nova.length < 6 || nova.length > 72) return json({ ok: false, erro: "A senha nova precisa ter de 6 a 72 caracteres." }, 400);
    conta.salt = novoSalt();
    conta.hash = await hashSenha(nova, conta.salt, env);
    conta.atualizado_em = new Date().toISOString();
    await gravarConta(env, conta);
    return json({ ok: true });
  }

  return json({ ok: false, erro: "Rota não encontrada." }, 404);
}

// ------------------------------------------------------------------ roteador

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const daApi = p === "/api/ping" || p === "/api/envios" || p.startsWith("/api/admin") ||
                  p.startsWith("/api/parceiro") || p.startsWith("/fotos/") || p.startsWith("/dados/");

    try {
      if (p === "/api/ping") {
        return json({ ok: true, envios: !!env.BASE, admin: !!(env.CHAVE_ADMIN || "").trim() });
      }

      // as rotas abaixo dependem do bucket
      if (daApi && !env.BASE) {
        return json({ ok: false, erro: "bucket R2 não conectado ao projeto (falta o binding BASE)" }, 503);
      }

      if (p === "/api/envios") {
        if (request.method === "POST") return receberEnvio(request, env);
        return json({ ok: false, erro: "Use o painel de aprovação para ver os envios." }, 405);
      }
      if (p.startsWith("/api/admin")) {
        return painelAdmin(request, env, p.replace(/^\/api\/admin\/?/, ""));
      }
      if (p.startsWith("/api/parceiro")) {
        return areaDoParceiro(request, env, p.replace(/^\/api\/parceiro\/?/, ""));
      }
      if (p.startsWith("/fotos/")) {
        if (request.method !== "GET") return json({ ok: false, erro: "Rota não encontrada." }, 404);
        return entregarFoto(request, env, decodeURIComponent(p.slice("/fotos/".length)));
      }
      if (p.startsWith("/dados/")) {
        if (request.method !== "GET") return json({ ok: false, erro: "Rota não encontrada." }, 404);
        return entregarDados(request, env, decodeURIComponent(p.slice("/dados/".length)));
      }

      // não serve o código-fonte, caso a pasta antiga ainda esteja no projeto
      if (p.startsWith("/functions/")) return new Response("não encontrado", { status: 404 });

      return env.ASSETS.fetch(request);
    } catch (e) {
      if (daApi) return json({ ok: false, erro: "Erro no servidor: " + (e && e.message ? e.message : e) }, 500);
      throw e;
    }
  }
};
