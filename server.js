  const sourcePath =
    `${outputPath}.original.jpg`;

  const cleanBase64 =
    String(
      imageBase64
    ).replace(
      /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
      ""
    );

  fs.writeFileSync(
    sourcePath,
    Buffer.from(
      cleanBase64,
      "base64"
    )
  );

  try {

    await runFFmpeg([
      "-y",

      "-i",
      sourcePath,

      "-vf",
      [
        "scale=1080:1920:force_original_aspect_ratio=increase",
        "crop=1080:1920"
      ].join(","),

      "-frames:v",
      "1",

      "-q:v",
      "2",

      outputPath
    ]);

  } finally {

    try {
      if (
        fs.existsSync(
          sourcePath
        )
      ) {
        fs.unlinkSync(
          sourcePath
        );
      }
    } catch (_) {}
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

/* =========================================================
   PROCESSA O JOB DE IMAGENS
========================================================= */

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

    job.status =
      "processing";

    job.progress =
      5;

    job.message =
      "Iniciando geracao das imagens";

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

      job.currentScene =
        scene.sceneNumber;

      job.message =
        `Gerando imagem ${i + 1} de ${scenes.length}`;

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

      const finalPrompt =
        buildFinalImagePrompt(
          scene.prompt,
          data.style
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

        outputPath
      });

      const imageUrl =
        `${publicBaseUrl()}/videos/images/${fileName}`;

      job.images.push({
        sceneNumber:
          scene.sceneNumber,

        title:
          scene.title,

        prompt:
          scene.prompt,

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
        image =>
          image.imageUrl
      );

    job.resolution =
      "1080x1920";

    job.aspectRatio =
      "9:16";

  } catch (error) {

    console.error(
      "ERRO AO GERAR IMAGENS:",
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

    /* =====================================================
       BAIXAR IMAGENS
    ===================================================== */

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

    /* =====================================================
       AUDIO / EDGE TTS
    ===================================================== */

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

    if (
      textToSpeak
    ) {

      job.message =
        "Gerando narracao em portugues";

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

      if (
        !audioUrl
      ) {
        throw new Error(
          "Informe text, narrationText ou audioUrl."
        );
      }

      job.message =
        "Baixando narracao";

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

    /* =====================================================
       CRIAR CENAS
    ===================================================== */

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
      ]);

      sceneFiles.push(
        scenePath
      );
    }

    /* =====================================================
       JUNTAR CENAS
    ===================================================== */

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
       ADICIONAR AUDIO
    ===================================================== */

    job.progress =
      70;

    job.message =
      "Adicionando narracao";

    const videoWithAudio =
      path.join(
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
      String(
        finalDuration
      ),

      "-movflags",
      "+faststart",

      videoWithAudio
    ]);

    /* =====================================================
       ADICIONAR LEGENDAS
    ===================================================== */

    job.progress =
      82;

    job.message =
      "Adicionando legendas";

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
      error => {

        res.json({
          success:
            true,

          status:
            "healthy",

          ffmpeg:
            !error,

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

/* =========================================================
   GERAR IMAGENS
========================================================= */

app.post(
  "/generate-images",
  requireApiKey,
  (req, res) => {

    const scenes =
      normalizeImagePrompts(
        req.body ||
        {}
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
            "Informe pelo menos um prompt."
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
            "Limite atual de 20 imagens por lote."
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
            "IMAGE_PROVIDER deve ser cloudflare."
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
   TTS
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
        req.body ||
        {};

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
              "Idioma permitido: pt-BR."
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
        "ERRO TTS:",
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
   RENDER
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
      req.body ||
      {};

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
            "Idioma permitido: pt-BR."
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
            "Informe text, narrationText ou audioUrl."
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
          DEFAULT_LANGUAGE,

        narrationProvider:
          textToSpeak
            ? "edge-tts"
            : "external-audio",

        voice:
          textToSpeak
            ? validatePtBrVoice(
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

        automaticCaptions:
          Boolean(
            textToSpeak
          ),

        statusUrl:
          `${publicBaseUrl()}/status/${jobId}`
      });
  }
);

/* =========================================================
   STATUS DO VIDEO
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
      `Idioma: ${DEFAULT_LANGUAGE}`
    );

    console.log(
      `Voz: ${DEFAULT_VOICE}`
    );

    console.log(
      `Modelo de imagem: ${DEFAULT_IMAGE_MODEL}`
    );
  }
);
