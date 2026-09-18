"""Lista Stories ativos (imagem e vídeo) usando a sessão do yt-dlp."""

import argparse
import json
import sys
from urllib.parse import urlparse

from yt_dlp import YoutubeDL
from yt_dlp.extractor.instagram import InstagramStoryIE, _pk_to_id


def melhor(candidatos):
    candidatos = [item for item in candidatos or [] if item.get("url")]
    if not candidatos:
        return None
    return max(
        candidatos,
        key=lambda item: (item.get("width") or 0) * (item.get("height") or 0),
    )


def extensao(url, padrao):
    caminho = urlparse(url).path
    if "." not in caminho:
        return padrao
    valor = caminho.rsplit(".", 1)[-1].lower()
    return valor if 1 <= len(valor) <= 5 else padrao


def listar(profile_url, cookies=None, browser=None):
    opcoes = {"quiet": True, "no_warnings": True, "skip_download": True}
    if cookies:
        opcoes["cookiefile"] = cookies
    if browser:
        opcoes["cookiesfrombrowser"] = (browser, None, None, None)

    with YoutubeDL(opcoes) as ydl:
        extrator = InstagramStoryIE(ydl)
        extrator.initialize()
        username = profile_url.rstrip("/").split("/")[-1]
        pagina = extrator._download_webpage(profile_url, username)
        user_info = extrator._search_json(
            r'"user":', pagina, "user info", username, fatal=False
        )
        if not user_info:
            raise RuntimeError("perfil inacessível para a sessão autenticada")

        user_id = str(user_info.get("pk") or user_info.get("id") or "")
        if not user_id:
            raise RuntimeError("não foi possível identificar o perfil")

        resposta = extrator._download_json(
            f"{extrator._API_BASE_URL}/feed/reels_media/?reel_ids={user_id}",
            username,
            headers=extrator._api_headers,
        )
        reels = resposta.get("reels") or {}
        reel = reels.get(user_id) or next(iter(reels.values()), {})
        usuario = reel.get("user") or {}
        itens = []

        for indice, item in enumerate(reel.get("items") or [], 1):
            video = melhor(item.get("video_versions"))
            imagem = melhor((item.get("image_versions2") or {}).get("candidates"))
            midia = video or imagem
            if not midia:
                continue

            tipo = "video" if video else "image"
            identificador = _pk_to_id(str(item.get("pk") or ""))
            legenda = item.get("caption") or {}
            itens.append(
                {
                    "id": identificador,
                    "pk": str(item.get("pk") or ""),
                    "index": indice,
                    "mediaType": tipo,
                    "mediaUrl": midia["url"],
                    "extension": extensao(midia["url"], "mp4" if video else "jpg"),
                    "width": midia.get("width"),
                    "height": midia.get("height"),
                    "duration": item.get("video_duration") if video else None,
                    "hasAudio": item.get("has_audio") if video else False,
                    "caption": legenda.get("text") if isinstance(legenda, dict) else "",
                    "timestamp": item.get("taken_at"),
                    "expiresAt": item.get("expiring_at"),
                }
            )

        return {
            "username": usuario.get("username") or username,
            "uploader": usuario.get("full_name") or username,
            "userId": user_id,
            "stories": itens,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--cookies")
    parser.add_argument("--cookies-from-browser", dest="browser")
    args = parser.parse_args()
    json.dump(
        listar(args.profile, cookies=args.cookies, browser=args.browser),
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
