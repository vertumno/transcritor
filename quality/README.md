# Corpus local de qualidade

Este diretório mede qualidade de transcrição sem enviar áudio para APIs.

## Amostras recomendadas

Separe trechos curtos e representativos, somando inicialmente 30 a 60 minutos:

1. fala limpa e próxima do microfone;
2. sala, eco e fala distante;
3. duas pessoas ou sobreposição;
4. música ou fala com trilha;
5. nomes próprios, siglas e termos técnicos.

Para cada trecho, crie manualmente uma referência fiel em `corpus/referencias/`.
Não use a saída de outro modelo como referência: ela precisa ser revisada por uma
pessoa, caso contrário o benchmark apenas aprende os erros do modelo anterior.

As transcrições que serão comparadas ficam em `corpus/hipoteses/`. Cadastre os
arquivos no `corpus/manifest.json`:

```json
{
  "criticalTerms": ["Claude Code", "FEEES"],
  "samples": [
    {
      "id": "fala-limpa-01",
      "reference": "referencias/fala-limpa-01.txt",
      "hypotheses": {
        "large-v3-qualidade": "hipoteses/fala-limpa-01-large-v3.txt",
        "turbo-rapido": "hipoteses/fala-limpa-01-turbo.txt"
      }
    }
  ]
}
```

Execute:

```bash
npm run quality:evaluate
```

O relatório apresenta WER, CER e recuperação de termos críticos. Quanto menores
WER/CER, melhor. Para termos, quanto maior, melhor.
