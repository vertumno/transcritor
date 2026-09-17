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


def transcrever(modelo, audio, idioma, prompt_vocabulario, usar_vad):
    """
    Roda o modelo e devolve (segmentos, info).

    O VAD (Silero) corta trechos sem fala e acelera bastante, mas classifica
    canto como silencio e zera a transcricao. Quem chama trata esse caso.
    """
    segmentos, info = modelo.transcribe(
        audio,
        language=None if idioma in ("auto", "", None) else idioma,
        beam_size=5,
        vad_filter=usar_vad,
        initial_prompt=prompt_vocabulario or None,
        condition_on_previous_text=False,  # evita loop de repeticao em audio longo
    )

    coletados = []
    duracao = info.duration or 0
    proximo_aviso = 0.0

    for seg in segmentos:
        texto = (seg.text or "").strip()
        if texto:
            coletados.append(
                {
                    "start": float(seg.start),
                    "duration": float(seg.end - seg.start),
                    "text": texto,
                }
            )
        # Progresso a cada 10% — audio longo demora e o usuario precisa ver vida
        if duracao > 0 and seg.end >= proximo_aviso:
            log(f"    {min(100, int(seg.end / duracao * 100))}%")
            proximo_aviso = seg.end + duracao * 0.1

    return coletados, info


def main():
    parser = argparse.ArgumentParser(description="Transcricao local via faster-whisper")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--modelo", default="large-v3-turbo")
    parser.add_argument("--idioma", default="pt")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--compute", default="auto")
    parser.add_argument("--prompt", default="")
    args = parser.parse_args()

    registrar_dlls_cuda()

    from faster_whisper import WhisperModel

    dispositivo = escolher_dispositivo(args.device)
    calculo = tipo_de_calculo(dispositivo, args.compute)

    def carregar(dev):
        log(f"  Carregando modelo {args.modelo} ({dev}/{tipo_de_calculo(dev, args.compute)})...")
        return WhisperModel(args.modelo, device=dev, compute_type=tipo_de_calculo(dev, args.compute))

    modelo = carregar(dispositivo)

    log("  Transcrevendo localmente...")
    try:
        segmentos, info = transcrever(modelo, args.audio, args.idioma, args.prompt, True)
    except Exception as exc:
        # GPU indisponivel ou sem memoria: repete na CPU em vez de falhar
        if dispositivo == "cuda" and erro_e_de_gpu(exc):
            log(f"  GPU falhou ({exc}); repetindo na CPU...")
            dispositivo, calculo = "cpu", tipo_de_calculo("cpu", args.compute)
            modelo = carregar("cpu")
            segmentos, info = transcrever(modelo, args.audio, args.idioma, args.prompt, True)
        else:
            raise

    # O VAD classifica canto como silencio e devolve zero segmentos.
    # Refazer sem VAD resolve — testado com video musical do acervo.
    if not segmentos:
        log("  Nenhuma fala detectada pelo VAD (audio cantado?) - refazendo sem VAD")
        segmentos, info = transcrever(modelo, args.audio, args.idioma, args.prompt, False)

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
    }

    with open(args.out, "w", encoding="utf-8") as arquivo:
        json.dump(resultado, arquivo, ensure_ascii=False)


if __name__ == "__main__":
    main()
