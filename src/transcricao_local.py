"""
Motor de transcricao local — faster-whisper (CTranslate2), sem API.

Roda como subprocesso chamado por local-whisper.js, no mesmo padrao dos
outros binarios externos do projeto (ffmpeg, yt-dlp).

Protocolo:
  stderr -> linhas de progresso, consumidas pelo Node e mostradas ao usuario
  --out  -> arquivo JSON com o resultado (evita problemas de encoding no
            stdout do Windows, que quebra acentuacao em cp1252)

O JSON de saida usa o mesmo contrato das outras rotas:
  { "text": str, "segments": [{"start", "duration", "text"}], "source": str }
"""

import argparse
import glob
import json
import os
import sys


def registrar_dlls_cuda():
    """
    As DLLs de CUDA vem dos pacotes pip nvidia-* e nao ficam no PATH do
    sistema. O CTranslate2 as carrega via LoadLibrary legado, que consulta
    o %PATH% — os.add_dll_directory() nao e suficiente aqui.

    O Node ja injeta esses diretorios no ambiente do subprocesso; isto aqui
    e a rede de seguranca para quando o script roda sozinho.
    """
    if os.name != "nt":
        return

    diretorios = []
    for base in set(sys.path):
        if base.endswith("site-packages"):
            diretorios.extend(glob.glob(os.path.join(base, "nvidia", "*", "bin")))

    novos = [d for d in diretorios if d not in os.environ.get("PATH", "")]
    if novos:
        os.environ["PATH"] = os.pathsep.join(novos) + os.pathsep + os.environ.get("PATH", "")


def log(mensagem):
    """Progresso vai para stderr; stdout fica livre para diagnostico."""
    print(mensagem, file=sys.stderr, flush=True)


def erro_e_de_gpu(exc):
    """
    Falta de cuBLAS/cuDNN ou memoria de video estoura so na hora de rodar o
    encoder, nao no carregamento. Por isso a deteccao e pela mensagem.
    """
    texto = str(exc).lower()
    marcadores = ("cublas", "cudnn", "cuda", "library", "out of memory", "device")
    return any(m in texto for m in marcadores)


def escolher_dispositivo(preferencia):
    """auto -> cuda quando houver GPU visivel, senao cpu."""
    if preferencia in ("cuda", "cpu"):
        return preferencia

    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


def tipo_de_calculo(dispositivo, preferencia):
    if preferencia != "auto":
        return preferencia
    # int8_float16 na GPU: ~1,6 GB de VRAM contra ~3,1 GB do float16 puro,
    # sem diferenca de texto nos testes — cabe folgado nos 4 GB da placa.
    return "int8_float16" if dispositivo == "cuda" else "int8"


def numero(valor, padrao=0.0):
    try:
        return float(valor)
    except (TypeError, ValueError):
        return padrao


def serializar_segmento(seg, offset=0.0):
    palavras = []
    for palavra in getattr(seg, "words", None) or []:
        palavras.append(
            {
                "start": numero(palavra.start) + offset,
                "end": numero(palavra.end) + offset,
                "word": palavra.word,
                "probability": numero(getattr(palavra, "probability", None), None),
            }
        )

    return {
        "start": numero(seg.start) + offset,
        "duration": numero(seg.end) - numero(seg.start),
        "text": (seg.text or "").strip(),
        "avg_logprob": numero(getattr(seg, "avg_logprob", None), -99.0),
        "no_speech_prob": numero(getattr(seg, "no_speech_prob", None), 0.0),
        "compression_ratio": numero(getattr(seg, "compression_ratio", None), 0.0),
        "temperature": numero(getattr(seg, "temperature", None), 0.0),
        "words": palavras,
    }


def transcrever(
    modelo,
    audio,
    idioma,
    prompt_vocabulario,
    usar_vad,
    perfil="qualidade",
    offset=0.0,
    usar_contexto=True,
    mostrar_progresso=True,
):
    """
    Roda o modelo e devolve (segmentos, info).

    O VAD (Silero) corta trechos sem fala e acelera bastante, mas classifica
    canto como silencio e zera a transcricao. Quem chama trata esse caso.
    """
    qualidade = perfil == "qualidade"
    vad_parameters = None
    if usar_vad and qualidade:
        # Mais conservador com fala baixa/curta que os padrões do Silero.
        vad_parameters = {
            "threshold": 0.35,
            "neg_threshold": 0.20,
            "min_speech_duration_ms": 100,
            "min_silence_duration_ms": 1000,
            "speech_pad_ms": 600,
        }

    segmentos, info = modelo.transcribe(
        audio,
        language=None if idioma in ("auto", "", None) else idioma,
        beam_size=8 if qualidade else 5,
        vad_filter=usar_vad,
        vad_parameters=vad_parameters,
        initial_prompt=prompt_vocabulario or None,
        hotwords=prompt_vocabulario or None,
        condition_on_previous_text=qualidade and usar_contexto,
        word_timestamps=qualidade,
        hallucination_silence_threshold=2.0 if qualidade else None,
    )

    coletados = []
    duracao = info.duration or 0
    proximo_aviso = 0.0

    for seg in segmentos:
        texto = (seg.text or "").strip()
        if texto:
            coletados.append(serializar_segmento(seg, offset))
        # Progresso a cada 10% — audio longo demora e o usuario precisa ver vida
        if mostrar_progresso and duracao > 0 and seg.end >= proximo_aviso:
            log(f"    {min(100, int(seg.end / duracao * 100))}%")
            proximo_aviso = seg.end + duracao * 0.1

    return coletados, info


def segmento_suspeito(seg):
    texto = seg.get("text", "")
    palavras = texto.lower().split()
    repeticao = len(palavras) >= 12 and len(set(palavras[-8:])) <= 2
    return (
        seg.get("avg_logprob", 0) < -0.85
        or seg.get("compression_ratio", 0) > 2.35
        or seg.get("no_speech_prob", 0) > 0.60
        or repeticao
    )


def juntar_intervalos(intervalos, duracao, margem=0.75):
    expandidos = []
    for inicio, fim in sorted(intervalos):
        inicio = max(0.0, inicio - margem)
        fim = min(duracao, fim + margem)
        if expandidos and inicio <= expandidos[-1][1] + 0.25:
            expandidos[-1] = (expandidos[-1][0], max(expandidos[-1][1], fim))
        else:
            expandidos.append((inicio, fim))
    return expandidos


def intervalo_tem_texto(intervalo, segmentos, cobertura_minima=0.20):
    inicio, fim = intervalo
    tamanho = max(0.001, fim - inicio)
    sobreposicao = 0.0
    for seg in segmentos:
        seg_inicio = seg["start"]
        seg_fim = seg_inicio + seg["duration"]
        sobreposicao += max(0.0, min(fim, seg_fim) - max(inicio, seg_inicio))
    return sobreposicao / tamanho >= cobertura_minima


def lacunas_detectadas_por_vad(audio, segmentos, duracao):
    """Segunda leitura sensível do VAD encontra fala que não gerou texto."""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        opcoes = VadOptions(
            threshold=0.20,
            neg_threshold=0.10,
            min_speech_duration_ms=80,
            min_silence_duration_ms=400,
            speech_pad_ms=500,
        )
        candidatos = get_speech_timestamps(audio, opcoes)
        taxa = 16000.0
        intervalos = [(c["start"] / taxa, c["end"] / taxa) for c in candidatos]
        ausentes = [i for i in intervalos if not intervalo_tem_texto(i, segmentos)]
        return juntar_intervalos(ausentes, duracao, margem=0.5)
    except Exception as exc:
        log(f"  Aviso: auditoria sensível do VAD indisponível ({exc})")
        return []


def auditar_trechos(audio, segmentos, duracao, auditar_vad=True):
    suspeitos = [
        (s["start"], s["start"] + s["duration"])
        for s in segmentos
        if segmento_suspeito(s)
    ]
    intervalos_suspeitos = juntar_intervalos(suspeitos, duracao)
    lacunas = lacunas_detectadas_por_vad(audio, segmentos, duracao) if auditar_vad else []
    return {
        "low_confidence_segments": len(suspeitos),
        "suspicious_intervals": [
            {"start": inicio, "end": fim} for inicio, fim in intervalos_suspeitos
        ],
        "vad_gap_intervals": len(lacunas),
        "suspected_vad_gaps": [
            {"start": inicio, "end": fim} for inicio, fim in lacunas
        ],
        "automatic_retries": 0,
        "accepted_retries": 0,
        "remaining_low_confidence_segments": 0,
        "retry_attempts": [],
    }


def sobrepoe_intervalo(seg, inicio, fim):
    seg_inicio = seg["start"]
    seg_fim = seg_inicio + seg["duration"]
    return seg_inicio < fim and seg_fim > inicio


def resumo_qualidade(segmentos):
    if not segmentos:
        return {"score": None, "suspicious": 0, "characters": 0}

    suspeitos = sum(1 for seg in segmentos if segmento_suspeito(seg))
    logprob = sum(seg.get("avg_logprob", -2.0) for seg in segmentos) / len(segmentos)
    silencio = sum(seg.get("no_speech_prob", 0.0) for seg in segmentos) / len(segmentos)
    compressao = sum(
        max(0.0, seg.get("compression_ratio", 0.0) - 2.20) for seg in segmentos
    ) / len(segmentos)
    probabilidades = [
        palavra["probability"]
        for seg in segmentos
        for palavra in seg.get("words", [])
        if palavra.get("probability") is not None
    ]
    confianca_palavras = (
        sum(probabilidades) / len(probabilidades) if probabilidades else 0.0
    )
    score = logprob + confianca_palavras - (silencio * 0.50) - (compressao * 0.50)
    return {
        "score": round(score, 4),
        "suspicious": suspeitos,
        "characters": sum(len(seg.get("text", "")) for seg in segmentos),
    }


def alvos_de_reprocessamento(diagnostico, duracao):
    origens = []
    for intervalo in diagnostico["suspicious_intervals"]:
        origens.append((intervalo["start"], intervalo["end"], "low_confidence"))
    for intervalo in diagnostico["suspected_vad_gaps"]:
        origens.append((intervalo["start"], intervalo["end"], "vad_gap"))

    alvos = []
    for inicio, fim, motivo in sorted(origens):
        inicio = max(0.0, inicio)
        fim = min(duracao, fim)
        if fim <= inicio:
            continue
        if alvos and inicio <= alvos[-1]["end"] + 0.25:
            alvos[-1]["end"] = max(alvos[-1]["end"], fim)
            if motivo not in alvos[-1]["reasons"]:
                alvos[-1]["reasons"].append(motivo)
        else:
            alvos.append({"start": inicio, "end": fim, "reasons": [motivo]})
    return alvos


def aceitar_reprocessamento(originais, candidatos, motivos):
    if not candidatos:
        return False, "nenhum texto reconhecido na segunda passagem"

    antes = resumo_qualidade(originais)
    depois = resumo_qualidade(candidatos)

    if not originais:
        return True, "fala recuperada em uma lacuna sem transcrição"
    if depois["suspicious"] < antes["suspicious"]:
        return True, "menos segmentos de baixa confiança"
    if "vad_gap" in motivos and depois["characters"] > antes["characters"] * 1.20:
        if depois["suspicious"] <= antes["suspicious"]:
            return True, "maior cobertura de texto na possível lacuna do VAD"
    if depois["score"] is not None and antes["score"] is not None:
        if depois["score"] >= antes["score"] + 0.05:
            return True, "pontuação de confiança superior"
    return False, "segunda passagem não melhorou a confiança"


def reprocessar_trechos_suspeitos(
    modelo,
    audio,
    segmentos,
    diagnostico,
    duracao,
    idioma,
    prompt_vocabulario,
):
    """Executa uma única segunda passagem, sem VAD, somente nos alvos auditados."""
    alvos = alvos_de_reprocessamento(diagnostico, duracao)
    aceitos = []
    tentativas = []
    taxa = 16000

    for indice, alvo in enumerate(alvos, 1):
        inicio, fim = alvo["start"], alvo["end"]
        originais = [
            seg for seg in segmentos if sobrepoe_intervalo(seg, inicio, fim)
        ]
        tentativa = {
            "start": round(inicio, 3),
            "end": round(fim, 3),
            "reasons": alvo["reasons"],
            "accepted": False,
            "original": resumo_qualidade(originais),
        }
        log(
            f"    Reprocessando trecho suspeito {indice}/{len(alvos)} "
            f"({inicio:.1f}s–{fim:.1f}s, {', '.join(alvo['reasons'])})..."
        )

        try:
            amostra_inicio = max(0, int(inicio * taxa))
            amostra_fim = min(len(audio), int(fim * taxa))
            trecho = audio[amostra_inicio:amostra_fim]
            candidatos, _ = transcrever(
                modelo,
                trecho,
                idioma,
                prompt_vocabulario,
                False,
                "qualidade",
                offset=inicio,
                usar_contexto=False,
                mostrar_progresso=False,
            )
            tentativa["retry"] = resumo_qualidade(candidatos)
            aceitar, motivo = aceitar_reprocessamento(
                originais, candidatos, alvo["reasons"]
            )
            tentativa["accepted"] = aceitar
            tentativa["decision"] = motivo
            if aceitar:
                aceitos.append((inicio, fim, candidatos))
        except Exception as exc:
            tentativa["retry"] = resumo_qualidade([])
            tentativa["decision"] = f"falha na segunda passagem: {exc}"
        tentativas.append(tentativa)

    if aceitos:
        preservados = [
            seg
            for seg in segmentos
            if not any(sobrepoe_intervalo(seg, inicio, fim) for inicio, fim, _ in aceitos)
        ]
        substitutos = [seg for _, _, novos in aceitos for seg in novos]
        segmentos = sorted(preservados + substitutos, key=lambda seg: seg["start"])

    diagnostico["automatic_retries"] = len(tentativas)
    diagnostico["accepted_retries"] = len(aceitos)
    diagnostico["remaining_low_confidence_segments"] = sum(
        1 for seg in segmentos if segmento_suspeito(seg)
    )
    diagnostico["retry_attempts"] = tentativas
    return segmentos, diagnostico


def main():
    parser = argparse.ArgumentParser(description="Transcricao local via faster-whisper")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--modelo", default="large-v3")
    parser.add_argument("--idioma", default="pt")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--compute", default="auto")
    parser.add_argument("--perfil", default="qualidade", choices=["qualidade", "rapido"])
    parser.add_argument("--vad", default="auto", choices=["auto", "on", "off"])
    parser.add_argument("--prompt", default="")
    args = parser.parse_args()

    registrar_dlls_cuda()

    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio

    dispositivo = escolher_dispositivo(args.device)
    calculo = tipo_de_calculo(dispositivo, args.compute)

    def carregar(dev):
        log(f"  Carregando modelo {args.modelo} ({dev}/{tipo_de_calculo(dev, args.compute)})...")
        return WhisperModel(args.modelo, device=dev, compute_type=tipo_de_calculo(dev, args.compute))

    modelo = carregar(dispositivo)
    log("  Decodificando áudio sem perda adicional...")
    audio = decode_audio(args.audio, sampling_rate=16000)
    usar_vad = args.vad != "off"

    log("  Transcrevendo localmente...")
    try:
        segmentos, info = transcrever(
            modelo, audio, args.idioma, args.prompt, usar_vad, args.perfil
        )
    except Exception as exc:
        # GPU indisponivel ou sem memoria: repete na CPU em vez de falhar
        if dispositivo == "cuda" and erro_e_de_gpu(exc):
            log(f"  GPU falhou ({exc}); repetindo na CPU...")
            dispositivo, calculo = "cpu", tipo_de_calculo("cpu", args.compute)
            modelo = carregar("cpu")
            segmentos, info = transcrever(
                modelo, audio, args.idioma, args.prompt, usar_vad, args.perfil
            )
        else:
            raise

    diagnostico = {
        "low_confidence_segments": 0,
        "suspicious_intervals": [],
        "vad_gap_intervals": 0,
        "suspected_vad_gaps": [],
        "automatic_retries": 0,
        "accepted_retries": 0,
        "remaining_low_confidence_segments": 0,
        "retry_attempts": [],
    }
    if args.perfil == "qualidade":
        duracao_audio = len(audio) / 16000.0
        log("  Auditando confiança e cobertura do VAD...")
        diagnostico = auditar_trechos(
            audio,
            segmentos,
            duracao_audio,
            auditar_vad=usar_vad,
        )
        log(
            "  Auditoria: "
            f"{diagnostico['low_confidence_segments']} segmento(s) de baixa confiança, "
            f"{diagnostico['vad_gap_intervals']} possível(is) lacuna(s) de VAD"
        )
        segmentos, diagnostico = reprocessar_trechos_suspeitos(
            modelo,
            audio,
            segmentos,
            diagnostico,
            duracao_audio,
            args.idioma,
            args.prompt,
        )
        if diagnostico["automatic_retries"]:
            log(
                "  Segunda passagem seletiva: "
                f"{diagnostico['accepted_retries']}/"
                f"{diagnostico['automatic_retries']} trecho(s) aceito(s)"
            )

    texto = " ".join(s["text"] for s in segmentos).strip()

    resultado = {
        "text": texto,
        "segments": segmentos,
        "source": f"local ({args.modelo}/{dispositivo})",
        "device": dispositivo,
        "compute": calculo,
        "model": args.modelo,
        "language": getattr(info, "language", args.idioma),
        "duration": getattr(info, "duration", 0),
        "duration_after_vad": getattr(info, "duration_after_vad", 0),
        "vad_coverage": (
            numero(getattr(info, "duration_after_vad", 0))
            / max(0.001, numero(getattr(info, "duration", 0), len(audio) / 16000.0))
            if usar_vad
            else 1.0
        ),
        "profile": args.perfil,
        "vad": args.vad,
        "diagnostics": diagnostico,
    }

    with open(args.out, "w", encoding="utf-8") as arquivo:
        json.dump(resultado, arquivo, ensure_ascii=False)


if __name__ == "__main__":
    main()
