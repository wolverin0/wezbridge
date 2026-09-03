-- wezterm-hyperlink-rules.lua — rutas de archivo clickeables en WezTerm (2026-09-03).
-- Pegar dentro de ~/.wezterm.lua (archivo del operador). Es determinista: WezTerm aplica
-- estas regex al texto de la pantalla y convierte lo que matchea en un hyperlink;
-- Ctrl+click (o el binding open-uri) lo abre con el programa por defecto de Windows:
-- .html -> navegador, .md -> editor. No depende de que el modelo "recuerde" nada:
-- alcanza con que en pantalla haya una ruta ABSOLUTA de Windows (G:\... o C:/...) o un
-- file:///. Las rutas RELATIVAS (artifacts/x.html) NO se pueden resolver desde el
-- terminal porque WezTerm no conoce el cwd del pane: por eso los panes deben imprimir
-- rutas absolutas cuando quieran que sean clickeables.
--
-- Uso: dentro de tu config, despues de crear `config`:
--   local links = dofile("G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge/docs/wezterm-hyperlink-rules.lua")
--   config.hyperlink_rules = links(wezterm)
-- (o copia el cuerpo de la funcion). Hace falta reiniciar/recargar la config (Ctrl+Shift+R).

return function(wezterm)
  local rules = wezterm.default_hyperlink_rules()

  -- Ruta absoluta de Windows con barra invertida o normal, con o sin comillas,
  -- terminada en una extension conocida. Los espacios ("Py Apps") se admiten SOLO
  -- entre comillas; sin comillas se corta en el primer espacio, asi que los panes
  -- deberian imprimir la ruta entre comillas o con barras normales y sin espacios.
  table.insert(rules, {
    regex = [["([A-Za-z]:[\\/][^"\n]+?\.(?:html?|md|txt|json|jsonl|log|png|jpe?g|pdf|cjs|mjs|js|ts|py|ps1|cmd|lua|yml|yaml|toml|csv))"]],
    format = "file:///$1",
  })
  table.insert(rules, {
    regex = [[\b([A-Za-z]:[\\/][^\s"'<>|*?]+?\.(?:html?|md|txt|json|jsonl|log|png|jpe?g|pdf|cjs|mjs|js|ts|py|ps1|cmd|lua|yml|yaml|toml|csv))\b]],
    format = "file:///$1",
  })
  -- file:/// explicitos con espacios codificados o entre comillas.
  table.insert(rules, {
    regex = [[\bfile:///[^\s"'<>]+]],
    format = "$0",
  })
  return rules
end
