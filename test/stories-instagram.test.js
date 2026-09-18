const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizarPerfilStories,
  isInstagramProfileUrl,
  mapearStories,
} = require("../src/download");

test("normaliza usuário e perfil do Instagram para a playlist de Stories", () => {
  assert.deepEqual(normalizarPerfilStories("@pessoa.teste"), {
    username: "pessoa.teste",
    url: "https://www.instagram.com/stories/pessoa.teste/",
  });
  assert.deepEqual(
    normalizarPerfilStories("https://instagram.com/pessoa.teste/?hl=pt-br"),
    {
      username: "pessoa.teste",
      url: "https://www.instagram.com/stories/pessoa.teste/",
    }
  );
});

test("não confunde Reel ou publicação com perfil", () => {
  assert.equal(isInstagramProfileUrl("https://instagram.com/reel/ABC123/"), false);
  assert.equal(isInstagramProfileUrl("https://instagram.com/p/ABC123/"), false);
  assert.equal(isInstagramProfileUrl("https://instagram.com/pessoa.teste/"), true);
});

test("mapeia cada Story ativo como trabalho independente", () => {
  const stories = mapearStories(
    {
      uploader: "Pessoa",
      stories: [
        {
          id: "111",
          mediaUrl: "https://cdn.example/111.mp4",
          mediaType: "video",
          extension: "mp4",
          caption: "Primeiro",
          duration: 7.5,
        },
        {
          id: "222",
          mediaUrl: "https://cdn.example/222.jpg",
          mediaType: "image",
          extension: "jpg",
        },
      ],
    },
    "pessoa"
  );

  assert.equal(stories.length, 2);
  assert.equal(stories[0].url, "https://www.instagram.com/stories/pessoa/");
  assert.equal(stories[0].mediaUrl, "https://cdn.example/111.mp4");
  assert.equal(stories[0].meta.title, "Story pessoa - 01");
  assert.equal(stories[0].meta.caption, "Primeiro");
  assert.equal(stories[1].meta.storyIndex, 2);
  assert.equal(stories[1].meta.mediaType, "image");
});
