// 📦 Importação de módulos principais
import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import got from 'got';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';

const app = express();
const PORT = process.env.PORT || 3000;

// ⚙️ Configurações básicas
app.set('trust proxy', 1); // Confiança no proxy para rate-limit

// 🛡️ Middleware de segurança HTTP
app.use(helmet());

// 🌍 Habilita CORS apenas para o domínio permitido
app.use(cors({
  origin: ['https://playflixtv.online'],
  methods: ['GET'],
}));

// 🚫 Limita número de requisições por IP
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 300 // 300 requisições por minuto
});
app.use(limiter);

// 🗜️ Habilita compressão GZIP para respostas
app.use(compression());

// 🚫 Bloqueia crawlers automatizados conhecidos
app.use((req, res, next) => {
  const ua = req.get('User-Agent') || '';
  const blockList = ['curl', 'wget', 'python', 'bot', 'spider', 'scrapy'];
  if (blockList.some(b => ua.toLowerCase().includes(b))) {
    return res.status(403).send('Acesso negado.');
  }
  next();
});

// 📊 Estatísticas globais do servidor
const stats = {
  totalRequests: 0,
  apiHits: 0,
  proxyHits: 0,
  cacheHits: 0,
  cacheMisses: 0,
  uniqueIPs: new Set(),
  errors: []
};
const recentCodes = [];
const startedAt = new Date();

// 📈 Middleware de contagem de requisições e IPs
app.use((req, res, next) => {
  stats.totalRequests++;
  stats.uniqueIPs.add(req.ip);

  if (req.path.startsWith('/api/getm3u8')) stats.apiHits++;
  else if (req.path.startsWith('/proxy')) stats.proxyHits++;

  next();
});

// 🧠 Caches em memória
const masterCache = new Map();
const proxyCache = new Map();

// 📏 Limita tamanho dos caches
function limitCacheSize(map, maxSize) {
  while (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

// 🤖 Puppeteer reutilizável com timer de inatividade
let browser;
let browserInactivityTimer;

function resetBrowserInactivityTimer() {
  if (browserInactivityTimer) clearTimeout(browserInactivityTimer);
  browserInactivityTimer = setTimeout(async () => {
    if (browser) {
      console.log('⏲️ Puppeteer inativo. Fechando navegador...');
      await browser.close();
      browser = null;
    }
  }, 5 * 60 * 1000);
}

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    });
    console.log('🧠 Puppeteer iniciado e reutilizável.');
  }
  resetBrowserInactivityTimer();
  return browser;
}

// 📊 Rota que retorna estatísticas para o dashboard
app.get('/stats', (req, res) => {
  res.json({
    totalRequests: stats.totalRequests,
    apiHits: stats.apiHits,
    proxyHits: stats.proxyHits,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    uniqueIPs: stats.uniqueIPs.size,
    errors: stats.errors.slice(-10),
    errorCount: stats.errors.length,
    uptime: ((Date.now() - startedAt.getTime()) / 1000).toFixed(0),
    recentCodes,
    cacheSizes: {
      masterCache: masterCache.size,
      proxyCache: proxyCache.size
    }
  });
});

// 🧹 Rota para limpar manualmente os caches
app.get('/clear-cache', (req, res) => {
  masterCache.clear();
  proxyCache.clear();
  res.json({
    success: true,
    message: 'Caches master e proxy foram limpos com sucesso. ✅'
  });
});

// 🔍 Rota para verificar se o Puppeteer está ativo
app.get('/status', (req, res) => {
  res.json({ browserRunning: !!browser });
});

// 🧪 Rota principal de extração do master.m3u8 com Puppeteer
app.get('/api/getm3u8/:code', async (req, res) => {
  const { code } = req.params;
  const now = Date.now();

  const cached = masterCache.get(code);
  if (cached && cached.expiresAt > now) {
    stats.cacheHits++;
    console.log('✅ Master.m3u8 cache HIT para', code);
    return res.json({ success: true, url: cached.url });
  }

  stats.cacheMisses++;
  const targetUrl = `https://26efp.com/bkg/${code}`;

  try {
    console.log('🔧 Puppeteer iniciando...');
    const browser = await getBrowser();
    const page = await browser.newPage();

    let tsSegmentUrl = null;
    page.on('request', req => {
      const url = req.url();
      if (url.includes('.ts') && !tsSegmentUrl) {
        console.log('🎯 .ts interceptado:', url);
        tsSegmentUrl = url;
      }
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate(() => {
  // Clica no botão do player JWPlayer
  const jwPlayBtn = document.querySelector('.jw-icon-display');
  if (jwPlayBtn) {
    jwPlayBtn.click();
  }

  // Força reprodução do <video> HTML5, se existir
  const video = document.querySelector('video');
  if (video) {
    video.muted = true;
    video.play().catch(() => {});
  }
});

    await page.waitForResponse(
      response => response.url().includes('.ts'),
      { timeout: 30000 }
    );

    await page.close();

    if (tsSegmentUrl) {
      const masterUrl = tsSegmentUrl.replace(/\/[^/]+\.ts/, '/master.m3u8');
      masterCache.set(code, {
        url: masterUrl,
        expiresAt: now + 3 * 60 * 60 * 1000
      });
      limitCacheSize(masterCache, 100);
      recentCodes.unshift(code);
      if (recentCodes.length > 20) recentCodes.pop();
      console.log('✅ Reconstruído e cacheado:', masterUrl);
      return res.json({ success: true, url: masterUrl });
    } else {
      return res.status(404).json({ success: false, error: 'Segmento .ts não encontrado' });
    }
  } catch (err) {
    console.error('❌ Erro:', err);
    stats.errors.push(err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 🔁 Rota de proxy que reescreve e cacheia conteúdo .m3u8 e .ts
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.m3u8;
  if (!targetUrl) return res.status(400).send('URL ausente.');
  const now = Date.now();

  const isPlaylist = targetUrl.includes('.m3u8');
  const cache = proxyCache.get(targetUrl);
  if (cache && cache.expiresAt > now) {
    stats.cacheHits++;
    console.log('✅ Proxy cache HIT:', targetUrl);
    res.setHeader('Content-Type', cache.contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(cache.body);
  }

  stats.cacheMisses++;

  try {
    const response = await got(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://26efp.com/'
      },
      timeout: { request: 30000 },
      responseType: isPlaylist ? 'text' : 'buffer'
    });

    if (isPlaylist) {
      let content = response.body;
      const base = new URL(targetUrl);
      base.pathname = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

      content = content.replace(/URI="([^"]+)"/g, (match, url) => {
        const absolute = url.startsWith('http') ? url : new URL(url, base).href;
        return `URI="https://${req.get('host')}/proxy?m3u8=${encodeURIComponent(absolute)}"`;
      });

      content = content.replace(/^(?!#)(.*\.(ts|m3u8)(\?.*)?)$/gm, match => {
        const absolute = match.startsWith('http') ? match : new URL(match, base).href;
        return `https://${req.get('host')}/proxy?m3u8=${encodeURIComponent(absolute)}`;
      });

      proxyCache.set(targetUrl, {
        body: content,
        contentType: 'application/vnd.apple.mpegurl',
        expiresAt: now + 3 * 60 * 60 * 1000
      });
      limitCacheSize(proxyCache, 200);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(content);
    } else {
      proxyCache.set(targetUrl, {
        body: response.body,
        contentType: response.headers['content-type'] || 'application/octet-stream',
        expiresAt: now + 3 * 60 * 60 * 1000
      });
      limitCacheSize(proxyCache, 200);

      res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(response.body);
    }
  } catch (err) {
    console.error('Erro no proxy:', err.message);
    stats.errors.push(err.message);
    return res.status(502).send(`Erro ao acessar conteúdo. ${err.message}`);
  }
});

// 🏠 Rota padrão para verificar que a API está ativa
app.get('/', (req, res) => {
  res.send('🟢 API + Proxy com cache, segurança e reescrita HLS ativa. Use /api/getm3u8/{code} ou /proxy?m3u8=...');
});

// 🚀 Inicializa o servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
