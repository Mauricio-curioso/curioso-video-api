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

const jobs = new Map();

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (error, stdout, stderr) => {
      if (error) {
        console.error(stderr);
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function requireApiKey(req, res, next) {
  const expectedKey = process.env.VIDEO_API_KEY;
  const receivedKey = req.get("x-api-key");

  if (!expectedKey) {
    return res.status(503).json({
      success: false,
      error: "API ainda nao configurada."
    });
  }

  if (!receivedKey) {
    return res.status(401).json({
      success: false,
      error: "API key nao informada."
    });
  }

  const expectedBuffer = Buffer.from(expectedKey);
  const receivedBuffer = Buffer.from(receivedKey);

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return res.status(401).json({
      success: false,
      error: "API key invalida."
    });
  }

  next();
}

async function downloadFile(url, destination) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 60000
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destination);

    response.data.pipe(writer);

    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function escapeSubtitleText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
}

async function processVideo(jobId, data) {
  const job = jobs.get(jobId);

  const {
    images,
    audioUrl,
    duration = 60,
    captions = []
  } = data;

  const jobDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    job.status = "processing";
    job.progress = 5;
    job.message = "Baixando arquivos";

    const imageFiles = [];

    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(jobDir, `image-${i}.jpg`);

      await downloadFile(images[i], imagePath);

      imageFiles.push(imagePath);
    }

    const audioPath = path.join(jobDir, "audio.mp3");

    await downloadFile(audioUrl, audioPath);

    job.progress = 20;
    job.message = "Criando cenas";

    const sceneDuration = duration / images.length;

    const sceneFiles = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const scenePath = path.join(jobDir, `scene-${i}.mp4`);

      job.progress =
        20 + Math.round(((i + 1) / imageFiles.length) * 35);

      job.message = `Criando cena ${i + 1} de ${imageFiles.length}`;

      await runFFmpeg([
        "-y",
        "-loop",
        "1",
        "-i",
        imageFiles[i],

        "-vf",
        [
          "scale=1080:1920:force_original_aspect_ratio=increase",
          "crop=1080:1920",
          "zoompan=z='min(zoom+0.0007,1.08)':d=1:s=1080x1920:fps=30",
          "format=yuv420p"
        ].join(","),

        "-t",
        String(sceneDuration),

        "-r",
        "30",

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "28",

        scenePath
      ]);

      sceneFiles.push(scenePath);
    }

    job.progress = 60;
    job.message = "Juntando cenas";

    const concatList = path.join(jobDir, "concat.txt");

    const concatContent = sceneFiles
      .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n");

    fs.writeFileSync(concatList, concatContent);

    const mergedVideo = path.join(jobDir, "merged.mp4");

    await runFFmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-c",
      "copy",
      mergedVideo
    ]);

    job.progress = 70;
    job.message = "Adicionando audio";

    const videoWithAudio = path.join(jobDir, "audio-video.mp4");

    await runFFmpeg([
      "-y",
      "-i",
      mergedVideo,
      "-i",
      audioPath,

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      "-c:v",
      "copy",

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-shortest",

      videoWithAudio
    ]);

    job.progress = 82;
    job.message = "Adicionando legendas";

    const outputPath = path.join(
      OUTPUT_DIR,
      `${jobId}.mp4`
    );

    if (captions.length > 0) {
      const drawTextFilters = captions.map(caption => {
        const text = escapeSubtitleText(caption.text);

        const start = Number(caption.start) || 0;
        const end = Number(caption.end) || duration;

        return (
          `drawtext=` +
          `text='${text}':` +
          `fontcolor=white:` +
          `fontsize=60:` +
          `borderw=5:` +
          `bordercolor=black:` +
          `x=(w-text_w)/2:` +
          `y=h-(text_h*3):` +
          `enable='between(t,${start},${end})'`
        );
      });

      await runFFmpeg([
        "-y",
        "-i",
        videoWithAudio,

        "-vf",
        drawTextFilters.join(","),

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "27",

        "-c:a",
        "copy",

        "-movflags",
        "+faststart",

        outputPath
      ]);
    } else {
      fs.copyFileSync(videoWithAudio, outputPath);
    }

    job.status = "completed";
    job.progress = 100;
    job.message = "Video concluido";

    job.videoUrl =
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` +
      `/videos/${jobId}.mp4`;

    job.resolution = "1080x1920";
    job.fps = 30;
    job.format = "mp4";
    job.duration = duration;

    console.log(`VIDEO CONCLUIDO: ${job.videoUrl}`);

  } catch (error) {
    console.error("ERRO:", error);

    job.status = "error";
    job.progress = 0;
    job.message = "Erro ao gerar video";
    job.error = error.message;
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Curioso AI Video API",
    status: "online"
  });
});

app.get("/health", async (req, res) => {
  execFile("ffmpeg", ["-version"], error => {
    res.json({
      success: true,
      status: "healthy",
      ffmpeg: !error
    });
  });
});

app.post("/render", requireApiKey, async (req, res) => {
  const {
    images,
    audioUrl,
    duration,
    captions
  } = req.body;

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Informe pelo menos uma imagem."
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
    jobId,
    status: "queued",
    progress: 0,
    message: "Renderizacao iniciada"
  });

  setImmediate(() => {
    processVideo(jobId, {
      images,
      audioUrl,
      duration,
      captions
    });
  });

  res.status(202).json({
    success: true,
    jobId,
    status: "queued",
    message: "Renderizacao iniciada",
    statusUrl:
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` +
      `/status/${jobId}`
  });
});

app.get("/status/:jobId", requireApiKey, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job nao encontrado."
    });
  }

  res.json({
    success: true,
    ...job
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Curioso Video API rodando na porta ${PORT}`);
});
