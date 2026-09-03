const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const crypto = require("crypto");
const { EdgeTTS } = require("node-edge-tts");

const app = express();

app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 10000;

const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEMP_DIR = path.join(__dirname, "temp");
const IMAGE_OUTPUT_DIR = path.join(OUTPUT_DIR, "images");

const DEFAULT_LANGUAGE = "pt-BR";
const DEFAULT_VOICE = "pt-BR-AntonioNeural";
const DEFAULT_RATE = "-5%";

const DEFAULT_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL ||
  "@cf/black-forest-labs/flux-1-schnell";

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(IMAGE_OUTPUT_DIR, { recursive: true });

app.use("/videos", express.static(OUTPUT_DIR));

const jobs = new Map();
const imageJobs = new Map();

/* =========================================================
   UTILIDADES
========================================================= */

function publicBaseUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }

  return `http://localhost:${PORT}`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCaptionText(text) {
  return cleanText(text)
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1");
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

/* =========================================================
   FFMPEG / FFPROBE
========================================================= */

function runCommand(
  command,
  args,
  maxBuffer = 20 * 1024 * 1024
) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`ERRO ${command.toUpperCase()}:`);
          console.error(stderr || error.message);

          return reject(
            new Error(
              stderr ||
                error.message ||
                `Erro desconhecido em ${command}`
            )
          );
        }

        resolve(stdout);
      }
    );
  });
}

async function getMediaDuration(filePath) {
  const stdout = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ],
    1024 * 1024
  );

  const duration = Number(String(stdout).trim());

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      "Nao foi possivel obter a duracao do audio."
    );
  }

  return duration;
}

/* =========================================================
   API KEY DA NOSSA API
========================================================= */

function requireApiKey(req, res, next) {
  const expectedKey =
    process.env.VIDEO_API_KEY;

  const receivedKey =
    req.get("x-api-key");

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

  const expectedBuffer =
    Buffer.from(expectedKey);

  const receivedBuffer =
    Buffer.from(receivedKey);

  if (
    expectedBuffer.length !==
      receivedBuffer.length ||
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

async function downloadFile(
  url,
  destination
) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Curioso-AI-Studio/1.0"
    }
  });

  await new Promise(
    (resolve, reject) => {
      const writer =
        fs.createWriteStream(
          destination
        );

      response.data.pipe(writer);

      writer.on(
        "finish",
        resolve
      );

      writer.on(
        "error",
        reject
      );
    }
  );
}

/* =========================================================
   GERACAO DE IMAGENS - CLOUDFLARE
========================================================= */

function getCloudflareImageModel(
  requestedModel
) {
  return (
    cleanText(requestedModel) ||
    process.env.CLOUDFLARE_IMAGE_MODEL ||
    "@cf/black-forest-labs/flux-1-schnell"
  );
}

function normalizeImagePrompts(body) {
  if (
    Array.isArray(body.prompts) &&
    body.prompts.length > 0
  ) {
    return body.prompts
      .map((item, index) => {
        if (
          typeof item === "string"
        ) {
          return {
            sceneNumber: index + 1,
            title: `Cena ${index + 1}`,
            prompt: cleanText(item)
          };
        }

        if (
          item &&
          typeof item === "object"
        ) {
          return {
            sceneNumber:
              Number(
                item.sceneNumber
              ) ||
              index + 1,

            title:
              cleanText(
                item.title
              ) ||
              `Cena ${index + 1}`,

            prompt:
              cleanText(
                item.imagePrompt ||
                item.prompt
              )
          };
        }

        return null;
      })
      .filter(
        item =>
          item &&
          item.prompt
      );
  }

  if (
    Array.isArray(body.scenes) &&
    body.scenes.length > 0
  ) {
    return body.scenes
      .map((scene, index) => {
        if (
          typeof scene === "string"
        ) {
          return {
            sceneNumber: index + 1,
            title: `Cena ${index + 1}`,
            prompt: cleanText(scene)
          };
        }

        if (
          scene &&
          typeof scene === "object"
        ) {
          return {
            sceneNumber:
              Number(
                scene.sceneNumber
              ) ||
              index + 1,

            title:
              cleanText(
                scene.title
              ) ||
              `Cena ${index + 1}`,

            prompt:
              cleanText(
                scene.imagePrompt ||
                scene.prompt
              )
          };
        }

        return null;
      })
      .filter(
        item =>
          item &&
          item.prompt
      );
  }

  if (
    typeof body.prompt ===
      "string" &&
    cleanText(body.prompt)
  ) {
    return [
      {
        sceneNumber: 1,
        title:
          cleanText(
            body.title
          ) ||
          "Cena 1",

        prompt:
          cleanText(
            body.prompt
          )
      }
    ];
  }

  return [];
}

function buildFinalImagePrompt(
  prompt,
  style
) {
  const baseStyle =
    cleanText(style) ||
    "cinematic documentary photography, realistic, dramatic lighting, investigative atmosphere, vertical portrait composition";

  return cleanText(
    `${prompt}. ${baseStyle}. ` +
      "single full-screen scene, no collage, no split screen, no text, no subtitles, no letters, no logo, no watermark"
  ).slice(
    0,
    2048
  );
}

async function generateCloudflareImage({
  prompt,
  model,
  seed,
  outputPath
}) {
  const accountId =
    process.env
      .CLOUDFLARE_ACCOUNT_ID;

  const apiToken =
    process.env
      .CLOUDFLARE_API_TOKEN;

  if (
    !accountId ||
    !apiToken
  ) {
    throw new Error(
      "Cloudflare nao configurado. Verifique CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN."
    );
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/ai/run/${model}`;

  const response =
    await axios({
      method: "POST",

      url,

      timeout: 240000,

      maxContentLength:
        Infinity,

      maxBodyLength:
        Infinity,

      headers: {
        Authorization:
          `Bearer ${apiToken}`,

        "Content-Type":
          "application/json"
      },

      data: {
        prompt,
        steps: 4,
        seed
      },

      validateStatus:
        () => true
    });

  if (
    response.status < 200 ||
    response.status >= 300
  ) {
    throw new Error(
      `Cloudflare HTTP ${response.status}: ${JSON.stringify(
        response.data
      )}`
    );
  }

  const imageBase64 =
    response?.data?.result?.image ||
    response?.data?.image ||
    null;

  if (!imageBase64) {
    throw new Error(
      `Cloudflare nao retornou a imagem esperada: ${JSON.stringify(
        response.data
      )}`
    );
  }

  const sourcePath =
    `${outputPath}.source.jpg`;

  const normalizedBase64 =
    String(
      imageBase64
    ).replace(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
      ""
    );

  fs.writeFileSync(
    sourcePath,
    Buffer.from(
      normalizedBase64,
      "base64"
    )
  );

  try {
    await runCommand(
      "ffmpeg",
      [
        "-y",

        "-i",
        sourcePath,

        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",

        "-frames:v",
        "1",

        "-q:v",
        "2",

        outputPath
      ]
    );
  } finally {
    safeUnlink(
      sourcePath
    );
  }

  if (
    !fs.existsSync(
      outputPath
    ) ||
    fs.statSync(
      outputPath
    ).size === 0
  ) {
    throw new Error(
      "Imagem final nao foi criada corretamente."
    );
  }
}

async function processImageJob(
  jobId,
  data
) {
  const job =
    imageJobs.get(
      jobId
    );

  try {
    const scenes =
      normalizeImagePrompts(
        data
      );

    const model =
      getCloudflareImageModel(
        data.model
      );

    const style =
      data.style;

    job.status =
      "processing";

    job.progress =
      5;

    job.message =
      `Preparando ${scenes.length} imagens`;

    job.model =
      model;

    job.totalImages =
      scenes.length;

    job.generatedCount =
      0;

    job.images =
      [];

    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {
      const scene =
        scenes[i];

      const seed =
        Number.isFinite(
          Number(
            data.seed
          )
        )
          ? Math.floor(
              Number(
                data.seed
              )
            ) + i
          : crypto.randomInt(
              1,
              2147483646
            );

      job.currentScene =
        scene.sceneNumber;

      job.progress =
        Math.max(
          10,
          Math.round(
            (
              i /
              scenes.length
            ) * 90
          )
        );

      job.message =
        `Gerando imagem ${i + 1} de ${scenes.length}`;

      const finalPrompt =
        buildFinalImagePrompt(
          scene.prompt,
          style
        );

      const fileName =
        `${jobId}-${String(
          i + 1
        ).padStart(
          2,
          "0"
        )}.jpg`;

      const outputPath =
        path.join(
          IMAGE_OUTPUT_DIR,
          fileName
        );

      await generateCloudflareImage({
        prompt:
          finalPrompt,

        model,

        seed,

        outputPath
      });

      const imageUrl =
        `${publicBaseUrl()}` +
        `/videos/images/${fileName}`;

      job.images.push({
        sceneNumber:
          scene.sceneNumber,

        title:
          scene.title,

        prompt:
          scene.prompt,

        seed,

        imageUrl,

        fileName
      });

      job.generatedCount =
        job.images.length;

      job.progress =
        Math.round(
          (
            (
              i + 1
            ) /
            scenes.length
          ) * 98
        );
    }

    job.status =
      "completed";

    job.progress =
      100;

    job.message =
      "Imagens geradas com sucesso";

    job.imageUrls =
      job.images.map(
        item =>
          item.imageUrl
      );

    job.resolution =
      "1080x1920";

    job.aspectRatio =
      "9:16";

  } catch (error) {
    console.error(
      "ERRO NO JOB DE IMAGENS:",
      error
    );

    job.status =
      "error";

    job.progress =
      0;

    job.message =
      "Erro ao gerar imagens";

    job.error =
      error?.message ||
      String(error);
  }
}

/* =========================================================
   LEGENDAS ASS
========================================================= */

function assTime(
  seconds
) {
  const total =
    Math.max(
      0,
      Number(seconds) || 0
    );

  const hours =
    Math.floor(
      total / 3600
    );

  const minutes =
    Math.floor(
      (
        total % 3600
      ) / 60
    );

  const secs =
    Math.floor(
      total % 60
    );

  const centiseconds =
    Math.floor(
      (
        total % 1
      ) * 100
    );

  return (
    `${hours}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")}.` +
    `${String(centiseconds).padStart(2, "0")}`
  );
}

function wrapCaptionText(
  text,
  maxCharsPerLine = 16
) {
  const cleaned =
    cleanText(text);

  if (!cleaned) {
    return "";
  }

  const words =
    cleaned.split(" ");

  const lines =
    [];

  let currentLine =
    "";

  for (
    const word of words
  ) {
    const candidate =
      currentLine
        ? `${currentLine} ${word}`
        : word;

    if (
      candidate.length <=
      maxCharsPerLine
    ) {
      currentLine =
        candidate;
    } else {
      if (
        currentLine
      ) {
        lines.push(
          currentLine
        );
      }

      currentLine =
        word;
    }
  }

  if (
    currentLine
  ) {
    lines.push(
      currentLine
    );
  }

  return lines.join(
    "\\N"
  );
}

function escapeAssText(
  text
) {
  return wrapCaptionText(
    text
  )
    .replace(
      /{/g,
      "\\{"
    )
    .replace(
      /}/g,
      "\\}"
    );
}

function createAssFile(
  captions,
  filePath,
  duration
) {
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

  captions.forEach(
    caption => {

      const start =
        assTime(
          caption.start ||
          0
        );

      const end =
        assTime(
          caption.end !==
            undefined
            ? caption.end
            : duration
        );

      const text =
        escapeAssText(
          caption.text
        );

      if (!text) {
        return;
      }

      ass +=
        `Dialogue: 0,${start},${end},Curioso,,0,0,0,,${text}\n`;
    }
  );

  fs.writeFileSync(
    filePath,
    ass,
    "utf8"
  );
}

/* =========================================================
   EDGE TTS
========================================================= */

function validateVoice(
  voice
) {
  const value =
    String(
      voice ||
      DEFAULT_VOICE
    ).trim();

  return value.startsWith(
    "pt-BR-"
  )
    ? value
    : DEFAULT_VOICE;
}

function validateRate(
  rate
) {
  const value =
    String(
      rate ||
      DEFAULT_RATE
    ).trim();

  if (
    value ===
    "default"
  ) {
    return value;
  }

  if (
    /^[+-]\d{1,2}%$/.test(
      value
    )
  ) {
    return value;
  }

  return DEFAULT_RATE;
}

function buildCaptionsFromWordTimings(
  wordTimings
) {
  const captions =
    [];

  let parts =
    [];

  let startMs =
    null;

  let endMs =
    null;

  function flush() {
    if (
      !parts.length ||
      startMs === null ||
      endMs === null
    ) {
      parts = [];
      startMs = null;
      endMs = null;
      return;
    }

    const text =
      normalizeCaptionText(
        parts.join(" ")
      );

    if (text) {
      captions.push({
        text,

        start:
          Number(
            (
              startMs /
              1000
            ).toFixed(3)
          ),

        end:
          Number(
            (
              endMs /
              1000
            ).toFixed(3)
          )
      });
    }

    parts = [];
    startMs = null;
    endMs = null;
  }

  for (
    const cue of
      wordTimings
  ) {
    const part =
      normalizeCaptionText(
        cue?.part
      );

    const cueStart =
      Number(
        cue?.start
      );

    const cueEnd =
      Number(
        cue?.end
      );

    if (
      !part ||
      !Number.isFinite(
        cueStart
      ) ||
      !Number.isFinite(
        cueEnd
      ) ||
      cueEnd <=
        cueStart
    ) {
      continue;
    }

    const candidateText =
      normalizeCaptionText(
        [
          ...parts,
          part
        ].join(" ")
      );

    const candidateStart =
      startMs === null
        ? cueStart
        : startMs;

    const candidateDuration =
      (
        cueEnd -
        candidateStart
      ) / 1000;

    if (
      parts.length > 0 &&
      (
        parts.length >= 5 ||
        candidateText.length >
          32 ||
        candidateDuration >
          2.6
      )
    ) {
      flush();
    }

    if (
      startMs === null
    ) {
      startMs =
        cueStart;
    }

    parts.push(
      part
    );

    endMs =
      cueEnd;

    if (
      /[.!?…]$/.test(
        part
      ) ||
      (
        /[,:;]$/.test(
          part
        ) &&
        parts.length >= 3
      ) ||
      parts.length >= 5
    ) {
      flush();
    }
  }

  flush();

  return captions;
}

async function generateEdgeNarration({
  text,
  audioPath,
  voice,
  rate
}) {
  const narrationText =
    cleanText(text);

  if (
    !narrationText
  ) {
    throw new Error(
      "Texto da narracao nao informado."
    );
  }

  const selectedVoice =
    validateVoice(
      voice
    );

  const selectedRate =
    validateRate(
      rate
    );

  const tts =
    new EdgeTTS({
      voice:
        selectedVoice,

      lang:
        DEFAULT_LANGUAGE,

      outputFormat:
        "audio-24khz-96kbitrate-mono-mp3",

      saveSubtitles:
        true,

      pitch:
        "default",

      rate:
        selectedRate,

      volume:
        "default",

      timeout:
        120000
    });

  await tts.ttsPromise(
    narrationText,
    audioPath
  );

  if (
    !fs.existsSync(
      audioPath
    ) ||
    fs.statSync(
      audioPath
    ).size === 0
  ) {
    throw new Error(
      "Edge TTS nao gerou o arquivo de audio."
    );
  }

  const subtitlePath =
    `${audioPath}.json`;

  if (
    !fs.existsSync(
      subtitlePath
    )
  ) {
    throw new Error(
      "Edge TTS nao gerou os timestamps das legendas."
    );
  }

  const wordTimings =
    JSON.parse(
      fs.readFileSync(
        subtitlePath,
        "utf8"
      )
    );

  if (
    !Array.isArray(
      wordTimings
    ) ||
    wordTimings.length ===
      0
  ) {
    throw new Error(
      "Edge TTS retornou timestamps vazios."
    );
  }

  const duration =
    await getMediaDuration(
      audioPath
    );

  const captions =
    buildCaptionsFromWordTimings(
      wordTimings
    );

  return {
    audioPath,

    duration,

    captions,

    voice:
      selectedVoice,

    rate:
      selectedRate
  };
}

/* =========================================================
   PROCESSAMENTO DO VIDEO
========================================================= */

async function processVideo(
  jobId,
  data
) {
  const job =
    jobs.get(
      jobId
    );

  const {
    images,
    audioUrl,
    text,
    narrationText,
    duration,
    captions = [],
    voice =
      DEFAULT_VOICE,
    rate =
      DEFAULT_RATE
  } = data;

  const jobDir =
    path.join(
      TEMP_DIR,
      jobId
    );

  fs.mkdirSync(
    jobDir,
    {
      recursive: true
    }
  );

  try {
    job.status =
      "processing";

    job.progress =
      5;

    job.message =
      "Baixando imagens";

    const imageFiles =
      [];

    for (
      let i = 0;
      i < images.length;
      i++
    ) {
      const imagePath =
        path.join(
          jobDir,
          `image-${i}.jpg`
        );

      await downloadFile(
        images[i],
        imagePath
      );

      imageFiles.push(
        imagePath
      );
    }

    const audioPath =
      path.join(
        jobDir,
        "narracao.mp3"
      );

    const textToSpeak =
      cleanText(
        narrationText ||
        text
      );

    let finalDuration;

    let finalCaptions;

    let finalVoice =
      null;

    let narrationProvider;

    job.progress =
      12;

    if (
      textToSpeak
    ) {
      job.message =
        "Gerando narracao e legendas sincronizadas";

      const ttsResult =
        await generateEdgeNarration({
          text:
            textToSpeak,

          audioPath,

          voice,

          rate
        });

      finalDuration =
        ttsResult.duration;

      finalCaptions =
        ttsResult.captions;

      finalVoice =
        ttsResult.voice;

      narrationProvider =
        "edge-tts";

      job.captionMode =
        "automatic-word-timestamps";

    } else {

      if (!audioUrl) {
        throw new Error(
          "Informe text/narrationText para gerar a voz automaticamente ou audioUrl para usar audio pronto."
        );
      }

      job.message =
        "Baixando narracao em portugues";

      await downloadFile(
        audioUrl,
        audioPath
      );

      const suppliedDuration =
        Number(
          duration
        );

      finalDuration =
        Number.isFinite(
          suppliedDuration
        ) &&
        suppliedDuration > 0
          ? suppliedDuration
          : await getMediaDuration(
              audioPath
            );

      finalCaptions =
        Array.isArray(
          captions
        )
          ? captions
          : [];

      narrationProvider =
        "external-audio";

      job.captionMode =
        finalCaptions.length
          ? "provided"
          : "none";
    }

    job.duration =
      Number(
        finalDuration.toFixed(
          3
        )
      );

    job.captionCount =
      finalCaptions.length;

    job.narrationProvider =
      narrationProvider;

    job.voice =
      finalVoice;

    job.progress =
      20;

    job.message =
      "Criando cenas";

    const sceneDuration =
      finalDuration /
      images.length;

    const sceneFiles =
      [];

    for (
      let i = 0;
      i < imageFiles.length;
      i++
    ) {
      const scenePath =
        path.join(
          jobDir,
          `scene-${i}.mp4`
        );

      job.progress =
        20 +
        Math.round(
          (
            (
              i + 1
            ) /
            imageFiles.length
          ) * 35
        );

      job.message =
        `Criando cena ${i + 1} de ${imageFiles.length}`;

      await runCommand(
        "ffmpeg",
        [
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
          String(
            sceneDuration
          ),

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
        ]
      );

      sceneFiles.push(
        scenePath
      );
    }

    job.progress =
      60;

    job.message =
      "Juntando cenas";

    const concatList =
      path.join(
        jobDir,
        "concat.txt"
      );

    const concatContent =
      sceneFiles
        .map(
          file =>
            `file '${file}'`
        )
        .join("\n");

    fs.writeFileSync(
      concatList,
      concatContent,
      "utf8"
    );

    const mergedVideo =
      path.join(
        jobDir,
        "merged.mp4"
      );

    await runCommand(
      "ffmpeg",
      [
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
      ]
    );

    job.progress =
      70;

    job.message =
      "Adicionando narracao pt-BR";

    const videoWithAudio =
      path.join(
        jobDir,
        "video-audio.mp4"
      );

    await runCommand(
      "ffmpeg",
      [
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
        String(
          finalDuration
        ),

        "-movflags",
        "+faststart",

        videoWithAudio
      ]
    );

    job.progress =
      82;

    job.message =
      "Adicionando legendas sincronizadas";

    const outputPath =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );

    if (
      Array.isArray(
        finalCaptions
      ) &&
      finalCaptions.length >
        0
    ) {
      const assPath =
        path.join(
          jobDir,
          "legendas.ass"
        );

      createAssFile(
        finalCaptions,
        assPath,
        finalDuration
      );

      await runCommand(
        "ffmpeg",
        [
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
        ]
      );

    } else {

      fs.copyFileSync(
        videoWithAudio,
        outputPath
      );
    }

    job.status =
      "completed";

    job.progress =
      100;

    job.message =
      "Video concluido";

    job.videoUrl =
      `${publicBaseUrl()}/videos/${jobId}.mp4`;

    job.resolution =
      "1080x1920";

    job.fps =
      30;

    job.format =
      "mp4";

    job.duration =
      Number(
        finalDuration.toFixed(
          3
        )
      );

    job.language =
      DEFAULT_LANGUAGE;

    job.voice =
      finalVoice;

    job.narrationProvider =
      narrationProvider;

    job.captionCount =
      finalCaptions.length;

    console.log(
      `VIDEO CONCLUIDO: ${job.videoUrl}`
    );

  } catch (error) {
    console.error(
      "ERRO NO JOB:",
      error
    );

    job.status =
      "error";

    job.progress =
      0;

    job.message =
      "Erro ao gerar video";

    job.error =
      error?.message ||
      String(error);
  }
}

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success:
        true,

      service:
        "Curioso AI Video API",

      status:
        "online",

      defaultLanguage:
        DEFAULT_LANGUAGE,

      defaultVoice:
        DEFAULT_VOICE,

      narrationProvider:
        "edge-tts",

      automaticCaptions:
        true,

      imageGeneration:
        true,

      imageProvider:
        "cloudflare",

      defaultImageModel:
        DEFAULT_IMAGE_MODEL,

      resolution:
        "1080x1920",

      fps:
        30
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {

    execFile(
      "ffmpeg",
      [
        "-version"
      ],
      ffmpegError => {

        execFile(
          "ffprobe",
          [
            "-version"
          ],
          ffprobeError => {

            res.json({
              success:
                true,

              status:
                "healthy",

              ffmpeg:
                !ffmpegError,

              ffprobe:
                !ffprobeError,

              edgeTts:
                true,

              cloudflareConfigured:
                Boolean(
                  process.env
                    .CLOUDFLARE_ACCOUNT_ID &&
                  process.env
                    .CLOUDFLARE_API_TOKEN
                ),

              imageProvider:
                process.env
                  .IMAGE_PROVIDER ||
                "cloudflare",

              defaultImageModel:
                DEFAULT_IMAGE_MODEL,

              language:
                DEFAULT_LANGUAGE,

              defaultVoice:
                DEFAULT_VOICE
            });
          }
        );
      }
    );
  }
);

/* =========================================================
   GERAR IMAGENS
========================================================= */

app.post(
  "/generate-images",
  requireApiKey,
  (req, res) => {

    const scenes =
      normalizeImagePrompts(
        req.body || {}
      );

    if (
      !scenes.length
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Informe pelo menos um prompt em prompt, prompts ou scenes."
        });
    }

    if (
      scenes.length >
      20
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Limite atual: 20 imagens por lote."
        });
    }

    const provider =
      String(
        process.env
          .IMAGE_PROVIDER ||
        "cloudflare"
      ).toLowerCase();

    if (
      provider !==
      "cloudflare"
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "IMAGE_PROVIDER deve estar configurado como cloudflare."
        });
    }

    if (
      !process.env
        .CLOUDFLARE_ACCOUNT_ID ||
      !process.env
        .CLOUDFLARE_API_TOKEN
    ) {
      return res
        .status(503)
        .json({
          success:
            false,

          error:
            "Cloudflare nao configurado no Render."
        });
    }

    const jobId =
      crypto.randomUUID();

    const model =
      getCloudflareImageModel(
        req.body?.model
      );

    imageJobs.set(
      jobId,
      {
        jobId,

        status:
          "queued",

        progress:
          0,

        message:
          "Geracao de imagens iniciada",

        provider:
          "cloudflare",

        model,

        totalImages:
          scenes.length,

        generatedCount:
          0,

        currentScene:
          null,

        resolution:
          "1080x1920",

        aspectRatio:
          "9:16",

        images:
          []
      }
    );

    setImmediate(
      () => {

        processImageJob(
          jobId,
          {
            ...(req.body || {}),

            scenes,

            model
          }
        );
      }
    );

    return res
      .status(202)
      .json({
        success:
          true,

        jobId,

        status:
          "queued",

        provider:
          "cloudflare",

        model,

        totalImages:
          scenes.length,

        message:
          "Geracao de imagens iniciada",

        statusUrl:
          `${publicBaseUrl()}/image-status/${jobId}`
      });
  }
);

/* =========================================================
   STATUS DAS IMAGENS
========================================================= */

app.get(
  "/image-status/:jobId",
  requireApiKey,
  (req, res) => {

    const job =
      imageJobs.get(
        req.params.jobId
      );

    if (!job) {
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "Job de imagens nao encontrado."
        });
    }

    return res.json({
      success:
        true,

      ...job
    });
  }
);

/* =========================================================
   TESTE TTS
========================================================= */

app.post(
  "/tts",
  requireApiKey,
  async (req, res) => {

    try {

      const {
        text,

        voice =
          DEFAULT_VOICE,

        rate =
          DEFAULT_RATE,

        language =
          DEFAULT_LANGUAGE

      } =
        req.body || {};

      if (
        String(
          language
        ).toLowerCase() !==
        "pt-br"
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Esta API esta configurada somente para portugues do Brasil (pt-BR)."
          });
      }

      if (
        !cleanText(
          text
        )
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Informe o campo text."
          });
      }

      const ttsId =
        crypto.randomUUID();

      const ttsDir =
        path.join(
          TEMP_DIR,
          `tts-${ttsId}`
        );

      fs.mkdirSync(
        ttsDir,
        {
          recursive: true
        }
      );

      const tempAudioPath =
        path.join(
          ttsDir,
          "narracao.mp3"
        );

      const result =
        await generateEdgeNarration({
          text,

          audioPath:
            tempAudioPath,

          voice,

          rate
        });

      const publicAudioPath =
        path.join(
          OUTPUT_DIR,
          `${ttsId}.mp3`
        );

      fs.copyFileSync(
        tempAudioPath,
        publicAudioPath
      );

      return res.json({
        success:
          true,

        provider:
          "edge-tts",

        language:
          DEFAULT_LANGUAGE,

        voice:
          result.voice,

        rate:
          result.rate,

        duration:
          Number(
            result.duration.toFixed(
              3
            )
          ),

        captions:
          result.captions,

        captionCount:
          result.captions.length,

        audioUrl:
          `${publicBaseUrl()}/videos/${ttsId}.mp3`
      });

    } catch (error) {

      console.error(
        "ERRO EDGE TTS:",
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error?.message ||
            String(error)
        });
    }
  }
);

/* =========================================================
   RENDER VIDEO
========================================================= */

app.post(
  "/render",
  requireApiKey,
  (req, res) => {

    const {
      images,
      audioUrl,
      text,
      narrationText,
      duration,
      captions,

      language =
        DEFAULT_LANGUAGE,

      voice =
        DEFAULT_VOICE,

      rate =
        DEFAULT_RATE

    } =
      req.body || {};

    if (
      !Array.isArray(
        images
      ) ||
      images.length ===
        0
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Informe pelo menos uma imagem."
        });
    }

    if (
      String(
        language
      ).toLowerCase() !==
      "pt-br"
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Esta API esta configurada somente para portugues do Brasil (pt-BR)."
        });
    }

    const textToSpeak =
      cleanText(
        narrationText ||
        text
      );

    if (
      !textToSpeak &&
      !audioUrl
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Informe text/narrationText para gerar a narracao automaticamente ou audioUrl para usar audio pronto."
        });
    }

    if (
      !textToSpeak &&
      duration !==
        undefined
    ) {
      const value =
        Number(
          duration
        );

      if (
        !Number.isFinite(
          value
        ) ||
        value <= 0
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "A duracao informada e invalida."
          });
      }
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
          textToSpeak
            ? "Renderizacao iniciada com voz e legendas automaticas"
            : "Renderizacao iniciada",

        language:
          DEFAULT_LANGUAGE,

        narrationProvider:
          textToSpeak
            ? "edge-tts"
            : "external-audio",

        voice:
          textToSpeak
            ? validateVoice(
                voice
              )
            : null
      }
    );

    setImmediate(
      () => {

        processVideo(
          jobId,
          {
            images,
            audioUrl,
            text,
            narrationText,
            duration,

            captions:
              Array.isArray(
                captions
              )
                ? captions
                : [],

            voice,

            rate
          }
        );
      }
    );

    return res
      .status(202)
      .json({
        success:
          true,

        jobId,

        status:
          "queued",

        language:
          DEFAULT_LANGUAGE,

        narrationProvider:
          textToSpeak
            ? "edge-tts"
            : "external-audio",

        voice:
          textToSpeak
            ? validateVoice(
                voice
              )
            : null,

        automaticCaptions:
          Boolean(
            textToSpeak
          ),

        message:
          textToSpeak
            ? "Renderizacao iniciada com voz e legendas automaticas"
            : "Renderizacao iniciada",

        statusUrl:
          `${publicBaseUrl()}/status/${jobId}`
      });
  }
);

/* =========================================================
   STATUS VIDEO
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
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "Job nao encontrado."
        });
    }

    return res.json({
      success:
        true,

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
      `Idioma padrao: ${DEFAULT_LANGUAGE}`
    );

    console.log(
      `Voz padrao: ${DEFAULT_VOICE}`
    );

    console.log(
      `Imagem: ${DEFAULT_IMAGE_MODEL}`
    );
  }
);
