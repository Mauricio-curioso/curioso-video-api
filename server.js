const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;

const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use("/videos", express.static(OUTPUT_DIR));

/*
  Armazena os jobs em memoria.
  Nesta primeira versao de teste isso e suficiente.
*/
const jobs = new Map();

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Curioso AI Video API",
    status: "online",
    mode: "async"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    ffmpeg: true,
    mode: "async"
  });
});

/*
  CONSULTAR STATUS
*/
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job nao encontrado."
    });
  }

  res.json(job);
});

async function downloadFile(url, destination) {
  console.log(`Baixando: ${url}`);

  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 10
  });

  const writer = fs.createWriteStream(destination);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => {
      console.log(`Download concluido: ${destination}`);
      resolve();
    });

    writer.on("error", reject);
  });
}

function runFFmpeg(args, etapa) {
  return new Promise((resolve, reject) => {
    console.log(`FFmpeg iniciado: ${etapa}`);

    execFile(
      "ffmpeg",
      args,
      {
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`ERRO FFMPEG - ${etapa}`);
          console.error(stderr);

          reject(
            new Error(stderr || error.message)
          );

          return;
        }

        console.log(`FFmpeg concluido: ${etapa}`);

        resolve();
      }
    );
  });
}

/*
  PROCESSAMENTO DO VIDEO
*/
async function processVideo(jobId, data, baseUrl) {
  const jobDir = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      images,
      audioUrl,
      duration = 6
    } = data;

    jobs.set(jobId, {
      success: true,
      jobId,
      status: "processing",
      progress: 5,
      message: "Iniciando renderizacao"
    });

    console.log("");
    console.log("=====================================");
    console.log(`PROCESSANDO JOB: ${jobId}`);
    console.log(`Imagens: ${images.length}`);
    console.log(`Duracao: ${duration}s`);
    console.log("=====================================");

    /*
      ETAPA 1 - IMAGENS
    */

    jobs.set(jobId, {
      success: true,
      jobId,
      status: "processing",
      progress: 10,
      message: "Baixando imagens"
    });

    const imagePaths = [];

    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(
        jobDir,
        `image-${String(i).padStart(3, "0")}.jpg`
      );

      await downloadFile(images[i], imagePath);

      imagePaths.push(imagePath);
    }

    /*
      ETAPA 2 - AUDIO
    */

    jobs.set(jobId, {
      success: true,
      jobId,
      status: "processing",
      progress: 25,
      message: "Baixando audio"
    });

    const audioPath = path.join(
      jobDir,
      "narration.mp3"
    );

    await downloadFile(audioUrl, audioPath);

    /*
      ETAPA 3 - CENAS
    */

    const sceneDuration =
      duration / images.length;

    const sceneVideos = [];

    for (let i = 0; i < imagePaths.length; i++) {
      const progress =
        30 +
        Math.round(
          ((i + 1) / imagePaths.length) * 40
        );

      jobs.set(jobId, {
        success: true,
        jobId,
        status: "processing",
        progress,
        message:
          `Criando cena ${i + 1} de ${imagePaths.length}`
      });

      const sceneVideo = path.join(
        jobDir,
        `scene-${String(i).padStart(3, "0")}.mp4`
      );

      const frames = Math.max(
        1,
        Math.round(sceneDuration * 24)
      );

      await runFFmpeg(
        [
          "-y",

          "-loop", "1",

          "-i", imagePaths[i],

          "-vf",
          `scale=540:960:force_original_aspect_ratio=increase,crop=540:960,zoompan=z='min(zoom+0.0015,1.08)':d=${frames}:s=540x960:fps=24,format=yuv420p`,

          "-t", String(sceneDuration),

          "-r", "24",

          "-c:v", "libx264",

          "-preset", "ultrafast",

          "-crf", "28",

          "-pix_fmt", "yuv420p",

          sceneVideo
        ],
        `Cena ${i + 1}/${imagePaths.length}`
      );

      sceneVideos.push(sceneVideo);
    }

    /*
      ETAPA 4 - CONCATENAR
    */

    jobs.set(jobId, {
      success: true,
      jobId,
      status: "processing",
      progress: 80,
      message: "Juntando cenas"
    });

    const concatFile =
      path.join(jobDir, "concat.txt");

    const concatContent =
      sceneVideos
        .map(video => `file '${video}'`)
        .join("\n");

    fs.writeFileSync(
      concatFile,
      concatContent
    );

    const videoWithoutAudio =
      path.join(jobDir, "video.mp4");

    await runFFmpeg(
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFile,
        "-c", "copy",
        videoWithoutAudio
      ],
      "Concatenacao"
    );

    /*
      ETAPA 5 - AUDIO
    */

    jobs.set(jobId, {
      success: true,
      jobId,
      status: "processing",
      progress: 90,
      message: "Adicionando audio"
    });

    const outputFilename =
      `${jobId}.mp4`;

    const outputPath =
      path.join(
        OUTPUT_DIR,
        outputFilename
      );

    await runFFmpeg(
      [
        "-y",

        "-i", videoWithoutAudio,

        "-i", audioPath,

        "-c:v", "copy",

        "-c:a", "aac",

        "-b:a", "128k",

        "-shortest",

        "-movflags", "+faststart",

        outputPath
      ],
      "Video final"
    );

    const videoUrl =
      `${baseUrl}/videos/${outputFilename}`;

    /*
      CONCLUIDO
    */

    jobs.set(jobId, {
      success: true,
      jobId,
      status: "completed",
      progress: 100,
      message: "Video concluido",
      videoUrl,
      resolution: "540x960",
      format: "mp4",
      duration
    });

    console.log("");
    console.log("=====================================");
    console.log("VIDEO CONCLUIDO");
    console.log(`JOB: ${jobId}`);
    console.log(`URL: ${videoUrl}`);
    console.log("=====================================");

  } catch (error) {
    console.error("");
    console.error("=====================================");
    console.error("ERRO NA RENDERIZACAO");
    console.error(`JOB: ${jobId}`);
    console.error(error);
    console.error("=====================================");

    jobs.set(jobId, {
      success: false,
      jobId,
      status: "error",
      progress: 0,
      message: "Erro na renderizacao",
      error: error.message
    });

  } finally {
    setTimeout(() => {
      fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        },
        () => {
          console.log(
            `Temporarios removidos: ${jobId}`
          );
        }
      );
    }, 300000);
  }
}

/*
  CRIAR NOVO JOB
*/
app.post("/render", (req, res) => {
  const {
    images,
    audioUrl,
    duration = 6
  } = req.body;

  if (
    !images ||
    !Array.isArray(images) ||
    images.length === 0
  ) {
    return res.status(400).json({
      success: false,
      error: "Nenhuma imagem recebida."
    });
  }

  if (!audioUrl) {
    return res.status(400).json({
      success: false,
      error: "audioUrl nao informado."
    });
  }

  const jobId = crypto.randomUUID();

  jobs.set(jobId, {
    success: true,
    jobId,
    status: "queued",
    progress: 0,
    message: "Job recebido"
  });

  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol;

  const host = req.get("host");

  const baseUrl =
    `${protocol}://${host}`;

  /*
    Inicia o processamento SEM esperar terminar.
  */
  setImmediate(() => {
    processVideo(
      jobId,
      {
        images,
        audioUrl,
        duration
      },
      baseUrl
    );
  });

  /*
    Responde imediatamente.
  */
  res.status(202).json({
    success: true,
    jobId,
    status: "queued",
    message: "Renderizacao iniciada",
    statusUrl:
      `${baseUrl}/status/${jobId}`
  });
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Curioso AI Video API assincrona rodando na porta ${PORT}`
    );
  }
);
