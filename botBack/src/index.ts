import express, { Request, Response } from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import P from "pino";
import axios from "axios";
import cron from "node-cron";
import cors from "cors";


// Inicializa o servidor Express
const app = express();
app.use(cors());
app.use(express.json());

let sock: ReturnType<typeof makeWASocket>;

let qrCodeGlobal: string | null = null;
let statusConnection: string = "Aguardando conexão...";

// Função principal para inicializar a conexão (somente se ainda não inicializada)
async function iniciarBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Windows", "Chrome", "121.0.0.0"],
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeGlobal = qr;
      statusConnection = "QR Code gerado";
      console.log("📲 QR Code gerado. Escaneie para conectar.");
    }

    if (connection === "open") {
      statusConnection = "Conectado ao WhatsApp!";
      qrCodeGlobal = null;
      console.log("✅ Conectado ao WhatsApp!");
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      console.log("❌ Conexão encerrada. Motivo:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        iniciarBaileys();
      } else {
        statusConnection = "Deslogado. Reautentique.";
        console.log("❌ Sessão encerrada no celular.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// 🚀 Inicia Baileys ao subir o servidor (só uma vez)
iniciarBaileys();

app.get("/gerar", (req: Request, res: Response) => {
  if (statusConnection === "Conectado ao WhatsApp!") {
     res.json({ status: statusConnection });
     return;
  }

  if (qrCodeGlobal) {
     res.json({ status: statusConnection, qrCode: qrCodeGlobal });
     return;
  }

   res.json({ status: "Aguardando geração do QR Code" });
   return;
});


// Rota de teste para enviar mensagem
app.post("/enviar", async (req: Request, res: Response) => {
  const { numero, mensagem } = req.body as {
    numero: string;
    mensagem: string;
  };

  if (!sock) {
    res.status(500).json({ erro: "WhatsApp não conectado." });
    return;
  }

  const jid = numero + "@s.whatsapp.net";

  try {
    await sock.sendMessage(jid, { text: mensagem });
    res.json({ status: "✅ Mensagem enviada com sucesso!" });
  } catch (error) {
    console.error("❌ Erro ao enviar mensagem:", error);
    res.status(500).json({ erro: "Erro ao enviar mensagem." });
  }
});

// Rota agendada por setTimeout
app.post("/agendar", async (req: Request, res: Response): Promise<void> => {
  const { numero, mensagem, dataHora } = req.body as {
    numero: string;
    mensagem: string;
    dataHora: string;
  };

  if (!sock) {
    res.status(500).json({ erro: "WhatsApp não conectado." });
    return;
  }

  const dataEnvio = new Date(dataHora);
  const agora = new Date();
  const delay = dataEnvio.getTime() - agora.getTime();

  if (delay <= 0) {
    res.status(400).json({ erro: "Data/hora de envio já passou." });
    return;
  }

  setTimeout(async () => {
    const jid = numero + "@s.whatsapp.net";
    try {
      await sock.sendMessage(jid, { text: mensagem });
      console.log(`✅ Mensagem enviada para ${numero} às ${dataEnvio}`);
    } catch (err) {
      console.error(`❌ Erro ao enviar mensagem agendada:`, err);
    }
  }, delay);

  res.json({ status: `Mensagem agendada para ${dataEnvio.toISOString()}` });
});

app.get("/vencimento", async (req: Request, res: Response): Promise<void> => {
  try {
    // Pega o valor da query string (?dias=...)
    const diasAntes = parseInt(req.query.dias as string) || 3; // se não passar, usa 3 por padrão

    const resposta = await axios.get("http://localhost:3000/api/listar");

    const clientes = resposta.data as {
      nome: string;
      dataVenc: string;
      numero: number;
    }[];

    const hoje = new Date();

    for (const cliente of clientes) {
      const dataVenc = new Date(cliente.dataVenc);
      const diffEmDias = Math.ceil((dataVenc.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));

      if (diffEmDias === diasAntes) {
        const mensagem = `Olá *${cliente.nome}*, seu plano vence em *${cliente.dataVenc}*. Por favor, regularize com antecedência.`;
        const jid = cliente.numero + "@s.whatsapp.net";

        try {
          await sock.sendMessage(jid, { text: mensagem });
          console.log(`✅ Mensagem enviada para ${cliente.nome} (${cliente.numero})`);
        } catch (err) {
          console.error(`❌ Erro ao enviar para ${cliente.nome}:`, err);
        }
      }
    }

    res.json({ status: `Mensagens processadas para vencimentos em ${diasAntes} dias.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao consultar /listar ou enviar mensagens." });
  }
});


// CRON: roda todos os dias às 09:00
cron.schedule("40 16 * * *", async () => {
  console.log("⏰ Executando verificação automática de vencimentos...");

  try {
    const resposta = await axios.get("http://localhost:3000/api/listar");

    const clientes = resposta.data as {
      nome: string;
      dataVenc: string;
      numero: number;
    }[];

    const hoje = new Date();

    for (const cliente of clientes) {
      const dataVenc = new Date(cliente.dataVenc);
      const diffEmDias = Math.ceil((dataVenc.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));

      if (diffEmDias === 3) {
        const mensagem = `Olá *${cliente.nome}*, seu plano vence em *${cliente.dataVenc}*. Por favor, regularize com antecedência.`;
        const jid = cliente.numero + "@s.whatsapp.net";

        try {
          await sock.sendMessage(jid, { text: mensagem });
          console.log(`✅ [CRON] Mensagem enviada para ${cliente.nome} (${cliente.numero})`);
        } catch (err) {
          console.error(`❌ [CRON] Erro ao enviar mensagem para ${cliente.nome}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("❌ [CRON] Erro ao consultar /listar ou enviar mensagens:", err);
  }
});


// Inicializa o servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
