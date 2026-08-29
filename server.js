const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 10000;

const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use("/videos", express.static(OUTPUT_DIR));

const jobs = new Map();

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      { maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          console.error("ERRO FFMPEG:");
          console.error(stderr);

          reject(
            new Error(
              stderr ||
              error.message ||
              "Erro desconhecido no FFmpeg"
            )
          );

          return;
        }

        resolve();
      }
    );
  });
}

/* =========================================================
   API KEY
========================================================= */

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
    !crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    )
  ) {
    return res.status(401).json({
      success: false,
      error: "API key invalida."
    });
  }

  next();
}

/* =========================================================
   DOWNLOAD
========================================================= */

async function downloadFile(url, destination) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destination);

    response.data.pipe(writer);

    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

/* =========================================================
   TEMPO DA LEGENDA ASS
========================================================= */

function assTime(seconds) {
  const total = Math.max(
    0,
    Number(seconds) || 0
  );

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centiseconds = Math.floor((total % 1) * 100);

  return (
    `${hours}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")}.` +
    `${String(centiseconds).padStart(2, "0")}`
  );
}

/* =========================================================
   LIMPA TEXTO
========================================================= */

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================================================
   QUEBRA SEGURA DA LEGENDA

   Limite menor para evitar corte lateral.
========================================================= */

function wrapCaptionText(text, maxCharsPerLine = 16) {
  const cleaned = cleanText(text);

  if (!cleaned) {
    return "";
  }

  const words = cleaned.split(" ");

  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine
      ? `${currentLine} ${word}`
      : word;

    if (candidate.length <= maxCharsPerLine) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }

      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join("\\N");
}

/* =========================================================
   ESCAPE PARA ASS
========================================================= */

function escapeAssText(text) {
  const wrapped = wrapCaptionText(text);

  return wrapped
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}");
}

/* =========================================================
   CRIA ARQUIVO DE LEGENDA
========================================================= */

function createAssFile(captions, filePath, duration) {
  let ass =
`[Script Info]
Title: Curioso AI Studio
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Curioso,DejaVu Sans,54,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,180,180,400,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  captions.forEach((caption) => {
    const start = assTime(
      caption.start || 0
    );

    const end = assTime(
      caption.end !== undefined
        ? caption.end
        : duration
    );

    const text = escapeAssText(
      caption.text
    );

    if (!text) {
      return;
    }

    ass +=
      `Dialogue: 0,${start},${end},Curioso,,0,0,0,,${text}\n`;
  });

  fs.writeFileSync(
    filePath,
    ass,
    "utf8"
  );
}

/* =========================================================
   PROCESSAMENTO DO VIDEO
========================================================= */

async function processVideo(jobId, data) {
  const job = jobs.get(jobId);

  const {
    images,
    audioUrl,
    duration = 10,
    captions = [],
    language = "pt-BR"
  } = data;

  const jobDir = path.join(
    TEMP_DIR,
    jobId
  );

  fs.mkdirSync(
    jobDir,
    { recursive: true }
  );

  try {

    /* =====================================================
       BAIXAR IMAGENS
    ===================================================== */

    job.status = "processing";
    job.progress = 5;
    job.message = "Baixando imagens";

    const imageFiles = [];

    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(
        jobDir,
        `image-${i}.jpg`
      );

      await downloadFile(
        images[i],
        imagePath
      );

      imageFiles.push(imagePath);
    }

    /* =====================================================
       BAIXAR NARRACAO
    ===================================================== */

    job.progress = 12;
    job.message =
      "Baixando narracao em portugues";

    const audioPath = path.join(
      jobDir,
      "narracao.mp3"
    );

    await downloadFile(
      audioUrl,
      audioPath
    );

    /* =====================================================
       CRIAR CENAS
    ===================================================== */

    job.progress = 20;
    job.message = "Criando cenas";

    const sceneDuration =
      duration / images.length;

    const sceneFiles = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const scenePath = path.join(
        jobDir,
        `scene-${i}.mp4`
      );

      job.progress =
        20 +
        Math.round(
          ((i + 1) / imageFiles.length) * 35
        );

      job.message =
        `Criando cena ${i + 1} de ${imageFiles.length}`;

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
          "zoompan=z='min(zoom+0.0005,1.06)':d=1:s=1080x1920:fps=30",
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

        "-pix_fmt",
        "yuv420p",

        scenePath
      ]);

      sceneFiles.push(scenePath);
    }

    /* =====================================================
       JUNTAR CENAS
    ===================================================== */

    job.progress = 60;
    job.message = "Juntando cenas";

    const concatList = path.join(
      jobDir,
      "concat.txt"
    );

    const concatContent = sceneFiles
      .map((file) => `file '${file}'`)
      .join("\n");

    fs.writeFileSync(
      concatList,
      concatContent,
      "utf8"
    );

    const mergedVideo = path.join(
      jobDir,
      "merged.mp4"
    );

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

    /* =====================================================
       ADICIONAR NARRACAO
    ===================================================== */

    job.progress = 70;

    job.message =
      "Adicionando narracao pt-BR";

    const videoWithAudio = path.join(
      jobDir,
      "video-audio.mp4"
    );

    await runFFmpeg([
      "-y",

      "-i",
      mergedVideo,

      "-i",
      audioPath,

      "-filter:a",
      "loudnorm=I=-16:LRA=11:TP=-1.5",

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

      "-ar",
      "48000",

      "-ac",
      "2",

      "-t",
      String(duration),

      "-movflags",
      "+faststart",

      videoWithAudio
    ]);

    /* =====================================================
       ADICIONAR LEGENDAS
    ===================================================== */

    job.progress = 82;

    job.message =
      "Adicionando legendas em portugues";

    const outputPath = path.join(
      OUTPUT_DIR,
      `${jobId}.mp4`
    );

    if (
      Array.isArray(captions) &&
      captions.length > 0
    ) {
      const assPath = path.join(
        jobDir,
        "legendas.ass"
      );

      createAssFile(
        captions,
        assPath,
        duration
      );

      await runFFmpeg([
        "-y",

        "-i",
        videoWithAudio,

        "-vf",
        `ass=${assPath}`,

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "27",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-movflags",
        "+faststart",

        outputPath
      ]);
    } else {
      fs.copyFileSync(
        videoWithAudio,
        outputPath
      );
    }

    /* =====================================================
       FINALIZADO
    ===================================================== */

    job.status = "completed";
    job.progress = 100;

    job.message =
      "Video concluido";

    job.videoUrl =
      `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` +
      `/videos/${jobId}.mp4`;

    job.resolution =
      "1080x1920";

    job.fps = 30;
    job.format = "mp4";
    job.duration = duration;
    job.language = "pt-BR";

    console.log(
      `VIDEO CONCLUIDO: ${job.videoUrl}`
    );

  } catch (error) {

    console.error(
      "ERRO NO JOB:",
      error
    );

    job.status = "error";
    job.progress = 0;

    job.message =
      "Erro ao gerar video";

    job.error =
      error.message;
  }
}

/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service:
      "Curioso AI Video API",
    status:
      "online",
    defaultLanguage:
      "pt-BR",
    resolution:
      "1080x1920",
    fps:
      30
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  execFile(
    "ffmpeg",
    ["-version"],
    (error) => {
      res.json({
        success: true,
        status:
          "healthy",
        ffmpeg:
          !error,
        language:
          "pt-BR"
      });
    }
  );
});

/* =========================================================
   RENDER
========================================================= */

app.post(
  "/render",
  requireApiKey,
  async (req, res) => {

    const {
      images,
      audioUrl,
      duration,
      captions,
      language = "pt-BR"
    } = req.body;

    if (
      !Array.isArray(images) ||
      images.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Informe pelo menos uma imagem."
      });
    }

    if (!audioUrl) {
      return res.status(400).json({
        success: false,
        error:
          "audioUrl nao informado."
      });
    }

    if (
      String(language).toLowerCase() !==
      "pt-br"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Esta API esta configurada somente para portugues do Brasil (pt-BR)."
      });
    }

    const videoDuration =
      Number(duration);

    if (
      !Number.isFinite(videoDuration) ||
      videoDuration <= 0
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Informe uma duracao valida."
      });
    }

    const jobId =
      crypto.randomUUID();

    jobs.set(
      jobId,
      {
        jobId,
        status:
          "queued",
        progress:
          0,
        message:
          "Renderizacao iniciada",
        language:
          "pt-BR"
      }
    );

    setImmediate(() => {
      processVideo(
        jobId,
        {
          images,
          audioUrl,
          duration:
            videoDuration,
          captions:
            Array.isArray(captions)
              ? captions
              : [],
          language:
            "pt-BR"
        }
      );
    });

    res.status(202).json({
      success:
        true,

      jobId,

      status:
        "queued",

      language:
        "pt-BR",

      message:
        "Renderizacao iniciada",

      statusUrl:
        `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` +
        `/status/${jobId}`
    });
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/status/:jobId",
  requireApiKey,
  (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        success: false,
        error:
          "Job nao encontrado."
      });
    }

    res.json({
      success: true,
      ...job
    });
  }
);

/* =========================================================
   INICIAR SERVIDOR
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Curioso AI Video API rodando na porta ${PORT}`
    );

    console.log(
      "Idioma padrao: Portugues do Brasil (pt-BR)"
    );
  }
);
