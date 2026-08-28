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

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Curioso AI Video API",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    ffmpeg: true
  });
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
          reject(new Error(stderr || error.message));
          return;
        }

        console.log(`FFmpeg concluido: ${etapa}`);
        resolve();
      }
    );
  });
}

app.post("/render", async (req, res) => {

  const jobId = crypto.randomUUID();
  const jobDir = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  console.log("");
  console.log("=====================================");
  console.log(`POST /render recebido`);
  console.log(`Job ID: ${jobId}`);
  console.log("=====================================");

  try {

    const {
      images,
      audioUrl,
      duration = 6
    } = req.body;

    console.log(`Quantidade de imagens: ${images?.length || 0}`);
    console.log(`Duracao solicitada: ${duration}s`);

    if (!images || !Array.isArray(images) || images.length === 0) {

      console.log("ERRO: nenhuma imagem recebida");

      return res.status(400).json({
        success: false,
        error: "Nenhuma imagem recebida."
      });
    }

    if (!audioUrl) {

      console.log("ERRO: audioUrl nao informado");

      return res.status(400).json({
        success: false,
        error: "audioUrl nao informado."
      });
    }

    console.log("ETAPA 1: baixando imagens");

    const imagePaths = [];

    for (let i = 0; i < images.length; i++) {

      const imagePath = path.join(
        jobDir,
        `image-${String(i).padStart(3, "0")}.jpg`
      );

      await downloadFile(images[i], imagePath);

      imagePaths.push(imagePath);
    }

    console.log("ETAPA 1 concluida");

    console.log("ETAPA 2: baixando audio");

    const audioPath = path.join(
      jobDir,
      "narration.mp3"
    );

    await downloadFile(
      audioUrl,
      audioPath
    );

    console.log("ETAPA 2 concluida");

    const sceneDuration =
      duration / images.length;

    const sceneVideos = [];

    console.log("ETAPA 3: criando cenas");

    for (let i = 0; i < imagePaths.length; i++) {

      const sceneVideo = path.join(
        jobDir,
        `scene-${String(i).padStart(3, "0")}.mp4`
      );

      const frames =
        Math.max(1, Math.round(sceneDuration * 24));

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

    console.log("ETAPA 3 concluida");

    console.log("ETAPA 4: juntando cenas");

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

    console.log("ETAPA 4 concluida");

    console.log("ETAPA 5: adicionando audio");

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

    console.log("ETAPA 5 concluida");

    const protocol =
      req.headers["x-forwarded-proto"] ||
      req.protocol;

    const host = req.get("host");

    const videoUrl =
      `${protocol}://${host}/videos/${outputFilename}`;

    console.log("=====================================");
    console.log("VIDEO CONCLUIDO");
    console.log(`Job: ${jobId}`);
    console.log(`URL: ${videoUrl}`);
    console.log("=====================================");

    res.json({
      success: true,
      jobId,
      status: "completed",
      videoUrl,
      resolution: "540x960",
      format: "mp4",
      duration
    });

  } catch (error) {

    console.error("");
    console.error("=====================================");
    console.error("ERRO NA RENDERIZACAO");
    console.error(`Job: ${jobId}`);
    console.error(error);
    console.error("=====================================");

    res.status(500).json({
      success: false,
      jobId,
      status: "error",
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
            `Arquivos temporarios removidos: ${jobId}`
          );
        }
      );

    }, 300000);
  }
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Curioso AI Video API rodando na porta ${PORT}`
    );
  }
);
