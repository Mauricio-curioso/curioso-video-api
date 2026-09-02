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
const GENERATED_IMAGES_DIR = path.join(__dirname, "generated-images");

const DEFAULT_LANGUAGE = "pt-BR";
const DEFAULT_VOICE = "pt-BR-AntonioNeural";
const DEFAULT_RATE = "-5%";
const DEFAULT_IMAGE_MODEL = "flux";

for (const dir of [
  OUTPUT_DIR,
  TEMP_DIR,
  GENERATED_IMAGES_DIR
]) {
  fs.mkdirSync(dir, {
    recursive: true
  });
}

app.use(
  "/videos",
  express.static(OUTPUT_DIR)
);

app.use(
  "/generated-images",
  express.static(GENERATED_IMAGES_DIR)
);

const jobs = new Map();
const imageJobs = new Map();

/* =========================================================
   FUNCOES BASICAS
========================================================= */

function publicBaseUrl() {
  return process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `http://localhost:${PORT}`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUnlink(file) {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (_) {}
}

/* =========================================================
   EXECUTAR COMANDOS
========================================================= */

function run(
  command,
  args,
  maxBuffer = 20 * 1024 * 1024
) {
  return new Promise(
    (resolve, reject) => {

      execFile(
        command,
        args,
        {
          maxBuffer
        },
        (
          error,
          stdout,
          stderr
        ) => {

          if (error) {
            console.error(
              `ERRO ${command.toUpperCase()}:`,
              stderr || error.message
            );

            return reject(
              new Error(
                stderr ||
                error.message ||
                `Erro em ${command}`
              )
            );
          }

          resolve(stdout);
        }
      );
    }
  );
}

/* =========================================================
   DURACAO AUDIO
========================================================= */

async function mediaDuration(
  file
) {

  const out = await run(
    "ffprobe",
    [
      "-v",
      "error",

      "-show_entries",
      "format=duration",

      "-of",
      "default=noprint_wrappers=1:nokey=1",

      file
    ],
    1024 * 1024
  );

  const value =
    Number(
      String(out).trim()
    );

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new Error(
      "Duracao de audio invalida."
    );
  }

  return value;
}

/* =========================================================
   SEGURANCA API
========================================================= */

function requireApiKey(
  req,
  res,
  next
) {

  const expected =
    process.env.VIDEO_API_KEY;

  const received =
    req.get("x-api-key");

  if (!expected) {

    return res
      .status(503)
      .json({
        success: false,
        error:
          "API ainda nao configurada."
      });
  }

  if (!received) {

    return res
      .status(401)
      .json({
        success: false,
        error:
          "API key nao informada."
      });
  }

  const a =
    Buffer.from(expected);

  const b =
    Buffer.from(received);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(
      a,
      b
    )
  ) {

    return res
      .status(401)
      .json({
        success: false,
        error:
          "API key invalida."
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

  const response =
    await axios({

      method:
        "GET",

      url,

      responseType:
        "stream",

      timeout:
        120000,

      maxRedirects:
        5,

      headers: {
        "User-Agent":
          "Curioso-AI-Studio/1.0"
      }
    });

  await new Promise(
    (
      resolve,
      reject
    ) => {

      const writer =
        fs.createWriteStream(
          destination
        );

      response.data.pipe(
        writer
      );

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
   IMAGEM - PROMPT FINAL
========================================================= */

function finalImagePrompt(
  scenePrompt,
  style
) {

  return cleanText(

    `${scenePrompt}. ` +

    `${
      style ||
      "cinematic documentary photography, realistic, dramatic lighting, investigative atmosphere, vertical 9:16 portrait composition"
    }. ` +

    "no text, no captions, no subtitles, no letters, no logo, no watermark, no frame, no collage, one single full-screen scene"
  );
}

/* =========================================================
   GERAR 1 IMAGEM NO POLLINATIONS
========================================================= */

async function generatePollinationsImage({
  prompt,
  outputPath,
  model = DEFAULT_IMAGE_MODEL,
  seed,
  enhance = true,
  safe = true
}) {

  const key =
    process.env
      .POLLINATIONS_API_KEY;

  if (!key) {

    throw new Error(
      "POLLINATIONS_API_KEY nao configurada no Render."
    );
  }

  const normalizedPrompt =
    cleanText(prompt)
      .slice(
        0,
        1800
      );

  if (!normalizedPrompt) {

    throw new Error(
      "Prompt da imagem vazio."
    );
  }

  const params =
    new URLSearchParams({

      model:
        cleanText(model) ||
        DEFAULT_IMAGE_MODEL,

      width:
        "1080",

      height:
        "1920",

      nologo:
        "true",

      private:
        "true",

      enhance:
        enhance
          ? "true"
          : "false",

      safe:
        safe
          ? "true"
          : "false"
    });

  if (
    Number.isFinite(
      Number(seed)
    )
  ) {

    params.set(
      "seed",
      String(
        Math.floor(
          Number(seed)
        )
      )
    );
  }

  const url =
    `https://gen.pollinations.ai/image/` +
    `${encodeURIComponent(
      normalizedPrompt
    )}?${params}`;

  const source =
    `${outputPath}.source`;

  try {

    const response =
      await axios({

        method:
          "GET",

        url,

        responseType:
          "arraybuffer",

        timeout:
          240000,

        maxRedirects:
          5,

        maxContentLength:
          Infinity,

        maxBodyLength:
          Infinity,

        headers: {

          Authorization:
            `Bearer ${key}`,

          Accept:
            "image/*",

          "User-Agent":
            "Curioso-AI-Studio/1.0"
        },

        validateStatus:
          () => true
      });

    if (
      response.status < 200 ||
      response.status >= 300
    ) {

      const detail =
        Buffer
          .from(
            response.data
          )
          .toString("utf8")
          .slice(
            0,
            1000
          );

      throw new Error(
        `Pollinations HTTP ${response.status}` +
        (
          detail
            ? `: ${detail}`
            : ""
        )
      );
    }

    const contentType =
      String(
        response
          .headers[
            "content-type"
          ] || ""
      );

    if (
      !contentType
        .startsWith(
          "image/"
        )
    ) {

      const detail =
        Buffer
          .from(
            response.data
          )
          .toString("utf8")
          .slice(
            0,
            1000
          );

      throw new Error(
        `Pollinations nao retornou imagem (${contentType}). ${detail}`
      );
    }

    fs.writeFileSync(
      source,
      Buffer.from(
        response.data
      )
    );

    /*
      NORMALIZA PARA 1080x1920
    */

    await run(
      "ffmpeg",
      [
        "-y",

        "-i",
        source,

        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",

        "-frames:v",
        "1",

        "-q:v",
        "2",

        outputPath
      ]
    );

    if (
      !fs.existsSync(
        outputPath
      ) ||
      !fs
        .statSync(
          outputPath
        )
        .size
    ) {

      throw new Error(
        "Imagem final nao foi criada."
      );
    }

  } finally {

    safeUnlink(
      source
    );
  }
}

/* =========================================================
   GERAR LOTE DE IMAGENS
========================================================= */

async function processImageBatch(
  jobId,
  {
    scenes,
    model,
    style,
    enhance,
    safe
  }
) {

  const job =
    imageJobs.get(
      jobId
    );

  try {

    const dir =
      path.join(
        GENERATED_IMAGES_DIR,
        jobId
      );

    fs.mkdirSync(
      dir,
      {
        recursive: true
      }
    );

    job.status =
      "processing";

    job.message =
      `Preparando ${scenes.length} imagens`;

    const results = [];

    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {

      const scene =
        scenes[i] || {};

      const sceneNumber =
        Number(
          scene.sceneNumber
        ) ||
        i + 1;

      const prompt =
        cleanText(
          scene.imagePrompt ||
          scene.prompt
        );

      if (!prompt) {

        throw new Error(
          `Cena ${sceneNumber} sem imagePrompt.`
        );
      }

      job.currentScene =
        sceneNumber;

      job.progress =
        Math.max(
          2,
          Math.round(
            (
              i /
              scenes.length
            ) * 95
          )
        );

      job.message =
        `Gerando imagem ${i + 1} de ${scenes.length}`;

      const fileName =
        `scene-${String(
          i + 1
        ).padStart(
          2,
          "0"
        )}.jpg`;

      const outputPath =
        path.join(
          dir,
          fileName
        );

      const seed =
        Number.isFinite(
          Number(
            scene.seed
          )
        )

          ? Number(
              scene.seed
            )

          : crypto
              .randomInt(
                1,
                2147483646
              );

      const builtPrompt =
        finalImagePrompt(
          prompt,
          style
        );

      await generatePollinationsImage({
        prompt:
          builtPrompt,

        outputPath,

        model,

        seed,

        enhance,

        safe
      });

      const item = {

        sceneNumber,

        title:
          cleanText(
            scene.title ||
            `Cena ${sceneNumber}`
          ),

        imagePrompt:
          prompt,

        seed,

        imageUrl:
          `${publicBaseUrl()}` +
          `/generated-images/` +
          `${jobId}/` +
          `${fileName}`
      };

      results.push(
        item
      );

      job.images =
        [
          ...results
        ];

      job.generatedCount =
        results.length;

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

    job.images =
      results;

    job.imageUrls =
      results.map(
        x =>
          x.imageUrl
      );

    job.generatedCount =
      results.length;

  } catch (error) {

    console.error(
      "ERRO IMAGENS:",
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
   LEGENDAS - TEMPO ASS
========================================================= */

function assTime(
  seconds
) {

  const total =
    Math.max(
      0,
      Number(seconds) || 0
    );

  const h =
    Math.floor(
      total / 3600
    );

  const m =
    Math.floor(
      (
        total % 3600
      ) / 60
    );

  const s =
    Math.floor(
      total % 60
    );

  const cs =
    Math.floor(
      (
        total % 1
      ) * 100
    );

  return (
    `${h}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")}.` +
    `${String(cs).padStart(2, "0")}`
  );
}

/* =========================================================
   QUEBRAR LEGENDA
========================================================= */

function wrapCaptionText(
  text,
  maxChars = 16
) {

  const words =
    cleanText(text)
      .split(" ")
      .filter(Boolean);

  const lines = [];

  let line = "";

  for (
    const word of words
  ) {

    const candidate =
      line
        ? `${line} ${word}`
        : word;

    if (
      candidate.length <=
      maxChars
    ) {

      line =
        candidate;

    } else {

      if (line) {

        lines.push(
          line
        );
      }

      line =
        word;
    }
  }

  if (line) {

    lines.push(
      line
    );
  }

  return lines.join(
    "\\N"
  );
}

/* =========================================================
   CRIAR ASS
========================================================= */

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

  for (
    const c of captions
  ) {

    const text =
      wrapCaptionText(
        c.text
      )
        .replace(
          /{/g,
          "\\{"
        )
        .replace(
          /}/g,
          "\\}"
        );

    if (!text) {
      continue;
    }

    ass +=
      `Dialogue: 0,` +
      `${assTime(
        c.start || 0
      )},` +
      `${assTime(
        c.end ??
        duration
      )},` +
      `Curioso,,0,0,0,,` +
      `${text}\n`;
  }

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

  const v =
    String(
      voice ||
      DEFAULT_VOICE
    ).trim();

  return v.startsWith(
    "pt-BR-"
  )
    ? v
    : DEFAULT_VOICE;
}

function validateRate(
  rate
) {

  const r =
    String(
      rate ||
      DEFAULT_RATE
    ).trim();

  return (
    r === "default" ||
    /^[+-]\d{1,2}%$/.test(
      r
    )
  )
    ? r
    : DEFAULT_RATE;
}

function normalizeCaptionText(
  text
) {

  return cleanText(text)

    .replace(
      /\s+([,.!?;:])/g,
      "$1"
    )

    .replace(
      /([¿¡])\s+/g,
      "$1"
    );
}

/* =========================================================
   TEMPOS AUTOMATICOS
========================================================= */

function buildCaptionsFromWordTimings(
  timings
) {

  const captions = [];

  let parts = [];
  let startMs = null;
  let endMs = null;

  const flush =
    () => {

      if (
        !parts.length ||
        startMs === null ||
        endMs === null
      ) {

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
    };

  for (
    const cue of timings
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
      cueEnd <= cueStart
    ) {

      continue;
    }

    const candidate =
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
      parts.length &&
      (
        parts.length >= 5 ||
        candidate.length > 32 ||
        candidateDuration > 2.6
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
      /[.!?…]$/.test(part) ||
      (
        /[,:;]$/.test(part) &&
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

/* =========================================================
   GERAR NARRACAO
========================================================= */

async function generateEdgeNarration({
  text,
  audioPath,
  voice,
  rate
}) {

  const narration =
    cleanText(text);

  if (!narration) {

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
    narration,
    audioPath
  );

  if (
    !fs.existsSync(
      audioPath
    ) ||
    !fs
      .statSync(
        audioPath
      )
      .size
  ) {

    throw new Error(
      "Edge TTS nao gerou audio."
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
      "Edge TTS nao gerou timestamps."
    );
  }

  const timings =
    JSON.parse(
      fs.readFileSync(
        subtitlePath,
        "utf8"
      )
    );

  if (
    !Array.isArray(
      timings
    ) ||
    !timings.length
  ) {

    throw new Error(
      "Timestamps do Edge TTS vazios."
    );
  }

  return {

    duration:
      await mediaDuration(
        audioPath
      ),

    captions:
      buildCaptionsFromWordTimings(
        timings
      ),

    voice:
      selectedVoice,

    rate:
      selectedRate
  };
}

/* =========================================================
   PROCESSAR VIDEO
========================================================= */

async function processVideo(
  jobId,
  data
) {

  const job =
    jobs.get(
      jobId
    );

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

    const {
      images,
      audioUrl,
      text,
      narrationText,
      duration,
      captions = [],
      voice = DEFAULT_VOICE,
      rate = DEFAULT_RATE
    } = data;

    job.status =
      "processing";

    job.progress =
      5;

    job.message =
      "Baixando imagens";

    const imageFiles = [];

    for (
      let i = 0;
      i < images.length;
      i++
    ) {

      const file =
        path.join(
          jobDir,
          `image-${i}.jpg`
        );

      await downloadFile(
        images[i],
        file
      );

      imageFiles.push(
        file
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
    let finalVoice = null;
    let narrationProvider;

    job.progress =
      12;

    if (textToSpeak) {

      job.message =
        "Gerando narracao e legendas sincronizadas";

      const tts =
        await generateEdgeNarration({

          text:
            textToSpeak,

          audioPath,

          voice,

          rate
        });

      finalDuration =
        tts.duration;

      finalCaptions =
        tts.captions;

      finalVoice =
        tts.voice;

      narrationProvider =
        "edge-tts";

      job.captionMode =
        "automatic-word-timestamps";

    } else {

      if (!audioUrl) {

        throw new Error(
          "Informe text/narrationText ou audioUrl."
        );
      }

      job.message =
        "Baixando narracao em portugues";

      await downloadFile(
        audioUrl,
        audioPath
      );

      const supplied =
        Number(
          duration
        );

      finalDuration =
        Number.isFinite(
          supplied
        ) &&
        supplied > 0

          ? supplied

          : await mediaDuration(
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
        finalDuration
          .toFixed(3)
      );

    job.captionCount =
      finalCaptions.length;

    job.narrationProvider =
      narrationProvider;

    job.voice =
      finalVoice;

    const sceneDuration =
      finalDuration /
      images.length;

    const sceneFiles = [];

    for (
      let i = 0;
      i < imageFiles.length;
      i++
    ) {

      const scene =
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

      await run(
        "ffmpeg",
        [
          "-y",

          "-loop",
          "1",

          "-i",
          imageFiles[i],

          "-vf",
          "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0005,1.06)':d=1:s=1080x1920:fps=30,format=yuv420p",

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

          scene
        ]
      );

      sceneFiles.push(
        scene
      );
    }

    job.progress =
      60;

    job.message =
      "Juntando cenas";

    const concat =
      path.join(
        jobDir,
        "concat.txt"
      );

    fs.writeFileSync(

      concat,

      sceneFiles
        .map(
          f =>
            `file '${f}'`
        )
        .join("\n"),

      "utf8"
    );

    const merged =
      path.join(
        jobDir,
        "merged.mp4"
      );

    await run(
      "ffmpeg",
      [
        "-y",

        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        concat,

        "-c",
        "copy",

        merged
      ]
    );

    job.progress =
      70;

    job.message =
      "Adicionando narracao pt-BR";

    const withAudio =
      path.join(
        jobDir,
        "video-audio.mp4"
      );

    await run(
      "ffmpeg",
      [
        "-y",

        "-i",
        merged,

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

        withAudio
      ]
    );

    job.progress =
      82;

    job.message =
      "Adicionando legendas sincronizadas";

    const output =
      path.join(
        OUTPUT_DIR,
        `${jobId}.mp4`
      );

    if (
      finalCaptions.length
    ) {

      const ass =
        path.join(
          jobDir,
          "legendas.ass"
        );

      createAssFile(
        finalCaptions,
        ass,
        finalDuration
      );

      await run(
        "ffmpeg",
        [
          "-y",

          "-i",
          withAudio,

          "-vf",
          `ass=${ass}`,

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

          output
        ]
      );

    } else {

      fs.copyFileSync(
        withAudio,
        output
      );
    }

    Object.assign(
      job,
      {

        status:
          "completed",

        progress:
          100,

        message:
          "Video concluido",

        videoUrl:
          `${publicBaseUrl()}/videos/${jobId}.mp4`,

        resolution:
          "1080x1920",

        fps:
          30,

        format:
          "mp4",

        duration:
          Number(
            finalDuration
              .toFixed(3)
          ),

        language:
          DEFAULT_LANGUAGE,

        voice:
          finalVoice,

        narrationProvider,

        captionCount:
          finalCaptions.length
      }
    );

  } catch (error) {

    console.error(
      "ERRO VIDEO:",
      error
    );

    Object.assign(
      job,
      {

        status:
          "error",

        progress:
          0,

        message:
          "Erro ao gerar video",

        error:
          error?.message ||
          String(error)
      }
    );
  }
}

/* =========================================================
   POST GERAR IMAGENS
========================================================= */

app.post(
  "/generate-images",
  requireApiKey,
  (
    req,
    res
  ) => {

    const {

      scenes,

      model =
        DEFAULT_IMAGE_MODEL,

      style,

      enhance =
        true,

      safe =
        true

    } =
      req.body || {};

    if (
      !process.env
        .POLLINATIONS_API_KEY
    ) {

      return res
        .status(503)
        .json({

          success:
            false,

          error:
            "POLLINATIONS_API_KEY nao configurada no Render."
        });
    }

    if (
      !Array.isArray(
        scenes
      ) ||
      !scenes.length
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          error:
            "Informe scenes com pelo menos uma cena."
        });
    }

    if (
      scenes.length > 20
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

    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {

      if (
        !cleanText(
          scenes[i]
            ?.imagePrompt ||
          scenes[i]
            ?.prompt
        )
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              `Cena ${i + 1} sem imagePrompt.`
          });
      }
    }

    const jobId =
      crypto.randomUUID();

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

        totalImages:
          scenes.length,

        generatedCount:
          0,

        currentScene:
          null,

        model,

        resolution:
          "1080x1920",

        aspectRatio:
          "9:16",

        images:
          []
      }
    );

    setImmediate(
      () =>
        processImageBatch(
          jobId,
          {
            scenes,
            model,
            style,

            enhance:
              Boolean(
                enhance
              ),

            safe:
              Boolean(
                safe
              )
          }
        )
    );

    res
      .status(202)
      .json({

        success:
          true,

        jobId,

        status:
          "queued",

        totalImages:
          scenes.length,

        model,

        message:
          "Geracao de imagens iniciada",

        statusUrl:
          `${publicBaseUrl()}/image-status/${jobId}`
      });
  }
);

/* =========================================================
   STATUS IMAGENS
========================================================= */

app.get(
  "/image-status/:jobId",
  requireApiKey,
  (
    req,
    res
  ) => {

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

    res.json({
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
  async (
    req,
    res
  ) => {

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
              "Somente pt-BR."
          });
      }

      if (
        !cleanText(text)
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              "Informe text."
          });
      }

      const id =
        crypto.randomUUID();

      const dir =
        path.join(
          TEMP_DIR,
          `tts-${id}`
        );

      fs.mkdirSync(
        dir,
        {
          recursive: true
        }
      );

      const tempAudio =
        path.join(
          dir,
          "narracao.mp3"
        );

      const result =
        await generateEdgeNarration({

          text,

          audioPath:
            tempAudio,

          voice,

          rate
        });

      const publicAudio =
        path.join(
          OUTPUT_DIR,
          `${id}.mp3`
        );

      fs.copyFileSync(
        tempAudio,
        publicAudio
      );

      res.json({

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
            result.duration
              .toFixed(3)
          ),

        captions:
          result.captions,

        captionCount:
          result
            .captions
            .length,

        audioUrl:
          `${publicBaseUrl()}/videos/${id}.mp3`
      });

    } catch (error) {

      res
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
  (
    req,
    res
  ) => {

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
      !images.length
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
            "Somente pt-BR."
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
            "Informe text/narrationText ou audioUrl."
        });
    }

    if (
      !textToSpeak &&
      duration !== undefined &&
      (
        !Number.isFinite(
          Number(duration)
        ) ||
        Number(duration) <= 0
      )
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          error:
            "Duracao invalida."
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
      () =>
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
        )
    );

    res
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
  (
    req,
    res
  ) => {

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

    res.json({

      success:
        true,

      ...job
    });
  }
);

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (
    req,
    res
  ) => {

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
        "pollinations",

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
  (
    req,
    res
  ) => {

    execFile(
      "ffmpeg",
      [
        "-version"
      ],
      (
        ffmpegError
      ) => {

        execFile(
          "ffprobe",
          [
            "-version"
          ],
          (
            ffprobeError
          ) => {

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

              pollinationsConfigured:
                Boolean(
                  process.env
                    .POLLINATIONS_API_KEY
                ),

              language:
                DEFAULT_LANGUAGE,

              defaultVoice:
                DEFAULT_VOICE,

              defaultImageModel:
                DEFAULT_IMAGE_MODEL
            });
          }
        );
      }
    );
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
      `Edge TTS: ${DEFAULT_VOICE}`
    );

    console.log(
      `Pollinations configurado: ${
        Boolean(
          process.env
            .POLLINATIONS_API_KEY
        )
      }`
    );
  }
);
