const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;

const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use("/videos", express.static(OUTPUT_DIR));


// ===============================
// TESTE DA API
// ===============================

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


// ===============================
// FUNÇÕES AUXILIARES
// ===============================

async function downloadFile(url, destination) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 60000
  });

  const writer = fs.createWriteStream(destination);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}


function runFFmpeg(args) {
  return new Promise((resolve, reject) => {

    execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {

      if (error) {
        console.error(stderr);
        reject(new Error(stderr || error.message));
        return;
      }

      resolve();
    });

  });
}


// ===============================
// RENDERIZAÇÃO
// ===============================

app.post("/render", async (req, res) => {

  const jobId = uuidv4();

  const jobDir = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  try {

    const {
      images,
      audioUrl,
      duration = 30
    } = req.body;


    if (!images || !Array.isArray(images) || images.length === 0) {

      return res.status(400).json({
        success: false,
        error: "Nenhuma imagem recebida."
      });

    }


    if (!audioUrl) {

      return res.status(400).json({
        success: false,
        error: "audioUrl não informado."
      });

    }


    // ===============================
    // BAIXAR IMAGENS
    // ===============================

    const imagePaths = [];

    for (let i = 0; i < images.length; i++) {

      const imagePath = path.join(
        jobDir,
        `image-${String(i).padStart(3, "0")}.jpg`
      );

      await downloadFile(images[i], imagePath);

      imagePaths.push(imagePath);
    }


    // ===============================
    // BAIXAR NARRAÇÃO
    // ===============================

    const audioPath = path.join(jobDir, "narration.mp3");

    await downloadFile(audioUrl, audioPath);


    // ===============================
    // DURAÇÃO DE CADA CENA
    // ===============================

    const sceneDuration = duration / images.length;


    // ===============================
    // CRIAR VÍDEOS DAS CENAS
    // ===============================

    const sceneVideos = [];

    for (let i = 0; i < imagePaths.length; i++) {

      const sceneVideo = path.join(
        jobDir,
        `scene-${String(i).padStart(3, "0")}.mp4`
      );


      const frames = Math.round(sceneDuration * 30);


      await runFFmpeg([

        "-y",

        "-loop", "1",

        "-i", imagePaths[i],

        "-vf",

        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0008,1.08)':d=${frames}:s=1080x1920:fps=30,format=yuv420p`,

        "-t", String(sceneDuration),

        "-r", "30",

        "-c:v", "libx264",

        "-preset", "veryfast",

        "-pix_fmt", "yuv420p",

        sceneVideo

      ]);


      sceneVideos.push(sceneVideo);

    }


    // ===============================
    // LISTA DE CENAS
    // ===============================

    const concatFile = path.join(jobDir, "concat.txt");

    const concatContent = sceneVideos
      .map(video => `file '${video}'`)
      .join("\n");

    fs.writeFileSync(concatFile, concatContent);


    const videoWithoutAudio = path.join(jobDir, "video.mp4");


    // ===============================
    // JUNTAR CENAS
    // ===============================

    await runFFmpeg([

      "-y",

      "-f", "concat",

      "-safe", "0",

      "-i", concatFile,

      "-c", "copy",

      videoWithoutAudio

    ]);


    // ===============================
    // ADICIONAR NARRAÇÃO
    // ===============================

    const outputFilename = `${jobId}.mp4`;

    const outputPath = path.join(
      OUTPUT_DIR,
      outputFilename
    );


    await runFFmpeg([

      "-y",

      "-i", videoWithoutAudio,

      "-i", audioPath,

      "-c:v", "copy",

      "-c:a", "aac",

      "-b:a", "192k",

      "-shortest",

      "-movflags", "+faststart",

      outputPath

    ]);


    // ===============================
    // URL DO VÍDEO
    // ===============================

    const protocol =
      req.headers["x-forwarded-proto"] || req.protocol;

    const host = req.get("host");

    const videoUrl =
      `${protocol}://${host}/videos/${outputFilename}`;


    res.json({

      success: true,

      jobId,

      status: "completed",

      videoUrl,

      resolution: "1080x1920",

      format: "mp4"

    });


  } catch (error) {

    console.error("ERRO NA RENDERIZAÇÃO:", error);

    res.status(500).json({

      success: false,

      status: "error",

      error: error.message

    });

  } finally {

    // Limpa arquivos temporários depois de 5 minutos

    setTimeout(() => {

      fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        },
        () => {}
      );

    }, 300000);

  }

});


// ===============================
// INICIAR SERVIDOR
// ===============================

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `Curioso AI Video API rodando na porta ${PORT}`
  );

});
