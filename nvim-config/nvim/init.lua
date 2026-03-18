-- Mineo bundled Neovim config
-- This is the default config shipped with Mineo.
-- Edit this file to customise the bundled experience,
-- or switch to "System config" / "Custom folder" in Settings (⌘,).

-- ============================================================================
-- [1] OPTIONS
-- ============================================================================

vim.g.mapleader               = " "
vim.g.maplocalleader          = " "
vim.g.have_nerd_font          = true

-- Disable unused providers (faster startup)
vim.g.loaded_perl_provider    = 0
vim.g.loaded_ruby_provider    = 0
vim.g.loaded_node_provider    = 0
vim.g.loaded_python3_provider = 0

-- Editor
vim.opt.number                = true
vim.opt.mouse                 = 'a'
vim.opt.termguicolors         = true
vim.opt.signcolumn            = "yes"
vim.opt.cursorline            = true
vim.opt.scrolloff             = 10
vim.opt.splitright            = true
vim.opt.splitbelow            = true
vim.opt.showmode              = false

-- Indentation
vim.opt.expandtab             = true
vim.opt.shiftwidth            = 2
vim.opt.tabstop               = 2
vim.opt.softtabstop           = 2
vim.opt.smartindent           = true

-- Search
vim.opt.ignorecase            = true
vim.opt.smartcase             = true
vim.opt.inccommand            = "split"

-- Performance
vim.opt.updatetime            = 300
vim.opt.timeoutlen            = 300
vim.opt.swapfile              = false
vim.opt.undofile              = true
vim.opt.undolevels            = 10000

-- Whitespace display
vim.opt.list        = true
vim.opt.listchars   = { tab = "| ", trail = "·", nbsp = "␣" }
vim.opt.breakindent = true

-- Clipboard (scheduled to avoid startup lag)
vim.schedule(function()
  vim.opt.clipboard = "unnamedplus"
end)

-- Ensure the cursor is always visible inside xterm.js (web terminal).
-- Without an explicit guicursor Neovim may emit no cursor-shape escape
-- codes, leaving the block cursor invisible when termguicolors is on.
vim.opt.guicursor = 'n-v-c-sm:block,i-ci-ve:ver25,r-cr-o:hor20'

-- ============================================================================
-- [2] KEYMAPS
-- ============================================================================

-- General
vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<CR>")
vim.keymap.set("n", ";", ":", { desc = "Command mode" })
vim.keymap.set("t", "<Esc><Esc>", "<C-\\><C-n>", { desc = "Exit terminal mode" })
vim.keymap.set("n", "<leader>q", vim.diagnostic.setloclist, { desc = "Quickfix diagnostics" })
vim.keymap.set('i', 'kj', '<Esc>', { noremap = true })

-- Window resize
vim.keymap.set("n", "<A-h>", ":vertical resize -2<CR>", { desc = "Window width -" })
vim.keymap.set("n", "<A-l>", ":vertical resize +2<CR>", { desc = "Window width +" })
vim.keymap.set("n", "<A-j>", ":resize -2<CR>", { desc = "Window height -" })
vim.keymap.set("n", "<A-k>", ":resize +2<CR>", { desc = "Window height +" })
vim.keymap.set("n", "<A-=>", "<C-w>=", { desc = "Equalise windows" })

-- Telescope
vim.keymap.set("n", "<leader>sh", function() require("telescope.builtin").help_tags() end, { desc = "[S]earch [H]elp" })
vim.keymap.set("n", "<leader>sk", function() require("telescope.builtin").keymaps() end, { desc = "[S]earch [K]eymaps" })
vim.keymap.set("n", "<leader>sf", function() require("telescope.builtin").find_files() end, { desc = "[S]earch [F]iles" })
vim.keymap.set("n", "<leader>ss", function() require("telescope.builtin").builtin() end, { desc = "[S]earch [S]elect" })
vim.keymap.set("n", "<leader>sw", function() require("telescope.builtin").grep_string() end, { desc = "[S]earch [W]ord" })
vim.keymap.set("n", "<leader>sg", function() require("telescope.builtin").live_grep() end, { desc = "[S]earch [G]rep" })
vim.keymap.set("n", "<leader>sd", function() require("telescope.builtin").diagnostics() end, { desc = "[S]earch [D]iagnostics" })
vim.keymap.set("n", "<leader>sr", function() require("telescope.builtin").resume() end, { desc = "[S]earch [R]esume" })
vim.keymap.set("n", "<leader>s.", function() require("telescope.builtin").oldfiles() end, { desc = "[S]earch Recent" })
vim.keymap.set("n", "<leader><leader>", function() require("telescope.builtin").buffers() end, { desc = "Find buffers" })
vim.keymap.set("n", "<leader>/", function()
  require("telescope.builtin").current_buffer_fuzzy_find(require("telescope.themes").get_dropdown({ winblend = 10, previewer = false }))
end, { desc = "Fuzzy search buffer" })

-- Snacks
vim.keymap.set("n", "<leader>tg", function() require("snacks").lazygit.open() end, { desc = "[T]oggle [G]it" })
vim.keymap.set("n", "<leader>tt", function() require("snacks").terminal.toggle() end, { desc = "[T]oggle [T]erminal" })
vim.keymap.set("n", "<leader>bdc", function() require("snacks").bufdelete.delete() end, { desc = "[B]uf [D]elete [C]urrent" })
vim.keymap.set("n", "<leader>bda", function() require("snacks").bufdelete.all() end, { desc = "[B]uf [D]elete [A]ll" })
vim.keymap.set("n", "<leader>bdo", function() require("snacks").bufdelete.other() end, { desc = "[B]uf [D]elete [O]ther" })

-- Flash (movement)
vim.keymap.set({ "n", "x", "o" }, "f", function() require("flash").jump() end, { desc = "Flash jump" })
vim.keymap.set({ "n", "x", "o" }, "F", function() require("flash").treesitter() end, { desc = "Flash treesitter" })

-- ============================================================================
-- [3] AUTOCMDS
-- ============================================================================

-- Highlight on yank
vim.api.nvim_create_autocmd("TextYankPost", {
  desc = "Highlight yanked text",
  group = vim.api.nvim_create_augroup("highlight-yank", { clear = true }),
  callback = function() vim.highlight.on_yank() end,
})

-- JSON: use jq for formatting
vim.api.nvim_create_autocmd("FileType", {
  pattern = "json",
  callback = function(ev) vim.bo[ev.buf].formatprg = "jq" end,
})

-- ============================================================================
-- [4] PLUGINS
-- ============================================================================

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  -- UI / Appearance
  { "catppuccin/nvim",                          name = "catppuccin" },
  { "folke/which-key.nvim" },
  { "nvim-tree/nvim-web-devicons" },
  { "echasnovski/mini.nvim" },

  -- Telescope
  { "nvim-lua/plenary.nvim" },
  { "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
  { "nvim-telescope/telescope-ui-select.nvim" },
  { "nvim-telescope/telescope.nvim" },

  -- File explorer
  { "MunifTanjim/nui.nvim" },
  { "nvim-neo-tree/neo-tree.nvim" },

  -- Editing
  { "nvim-treesitter/nvim-treesitter",          build = ":TSUpdate" },
  { "folke/flash.nvim" },
  { "folke/todo-comments.nvim" },

  -- Completion
  { "saghen/blink.cmp" },

  -- LSP / Tools
  { "williamboman/mason.nvim" },

  -- Git
  { "lewis6991/gitsigns.nvim" },

  -- Navigation / Utilities
  { "mrjones2014/smart-splits.nvim" },
  { "folke/snacks.nvim" },
})

-- ============================================================================
-- [5] PLUGIN CONFIG
-- ============================================================================

-- Theme -----------------------------------------------------------------------
require("catppuccin").setup({
  flavour = "mocha",
  transparent_background = true,
  show_end_of_buffer = false,
  term_colors = true,
  dim_inactive = { enabled = false },
  styles = {
    comments     = { "italic" },
    conditionals = { "italic" },
  },
  custom_highlights = function(colors)
    return {
      Normal                 = { bg = "NONE" },
      NormalNC               = { bg = "NONE" },
      NormalFloat            = { bg = "NONE" },
      FloatBorder            = { bg = "NONE" },
      SignColumn             = { bg = "NONE" },
      CursorLine             = { bg = "NONE" },
      CursorLineNr           = { bg = "NONE" },
      LineNr                 = { bg = "NONE" },
      StatusLine             = { bg = "NONE" },
      StatusLineNC           = { bg = "NONE" },
      TabLine                = { bg = "NONE" },
      TabLineFill            = { bg = "NONE" },
      WinSeparator           = { bg = "NONE" },
      VertSplit              = { bg = "NONE" },
      Pmenu                  = { bg = "NONE" },
      PmenuSel               = { bg = "NONE", bold = true },
      TelescopeNormal        = { bg = "NONE" },
      TelescopeBorder        = { bg = "NONE" },
      TelescopePromptNormal  = { bg = "NONE" },
      TelescopePromptBorder  = { bg = "NONE" },
      TelescopeResultsNormal = { bg = "NONE" },
      TelescopeResultsBorder = { bg = "NONE" },
      TelescopePreviewNormal = { bg = "NONE" },
      TelescopePreviewBorder = { bg = "NONE" },
      WhichKeyFloat          = { bg = "NONE" },
      NeoTreeNormal          = { bg = "NONE" },
      NeoTreeNormalNC        = { bg = "NONE" },
    }
  end,
  integrations = {
    gitsigns   = true,
    treesitter = true,
    mini       = { enabled = true, indentscope_color = "" },
    native_lsp = {
      enabled      = true,
      virtual_text = { errors = { "italic" }, hints = { "italic" }, warnings = { "italic" }, information = { "italic" } },
      underlines   = { errors = { "underline" }, hints = { "underline" }, warnings = { "underline" }, information = { "underline" } },
      inlay_hints  = { background = false },
    },
    telescope = { enabled = true },
    which_key = true,
  },
})
vim.cmd.colorscheme("catppuccin")

-- Which-key -------------------------------------------------------------------
require("which-key").setup({
  delay = 0,
  icons = { mappings = vim.g.have_nerd_font, keys = {} },
  spec = {
    { "<leader>c", group = "[C]ode",     mode = { "n", "x" } },
    { "<leader>d", group = "[D]ocument" },
    { "<leader>r", group = "[R]ename" },
    { "<leader>s", group = "[S]earch" },
    { "<leader>w", group = "[W]orkspace" },
    { "<leader>t", group = "[T]oggle" },
    { "<leader>h", group = "Git [H]unk", mode = { "n", "v" } },
    { "<leader>l", group = "[L]SP" },
    { "<leader>b", group = "[B]uffer" },
  },
})

-- Mini ------------------------------------------------------------------------
require("mini.ai").setup({ n_lines = 500 })
require("mini.surround").setup()
local statusline = require("mini.statusline")
statusline.setup({ use_icons = vim.g.have_nerd_font })
statusline.section_location = function() return "%2l:%-2v" end

-- Telescope -------------------------------------------------------------------
require("telescope").setup({
  defaults = {
    layout_strategy = "flex",
    layout_config = { height = 0.95 },
  },
  extensions = {
    ["ui-select"] = { require("telescope.themes").get_dropdown() },
  },
})
pcall(require("telescope").load_extension, "fzf")
pcall(require("telescope").load_extension, "ui-select")

-- File explorer ---------------------------------------------------------------
vim.keymap.set("n", "\\", ":Neotree reveal<CR>", { desc = "NeoTree reveal", silent = true })
require("neo-tree").setup({
  filesystem = { window = { mappings = { ["\\"] = "close_window" } } },
})

-- Treesitter ------------------------------------------------------------------
require("nvim-treesitter.configs").setup({
  ensure_installed = {
    "bash", "c", "diff", "html", "lua", "luadoc",
    "markdown", "markdown_inline", "query", "vim", "vimdoc",
  },
  auto_install = true,
  highlight = {
    enable = true,
    disable = function(_, buf)
      local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(buf))
      return ok and stats and stats.size > 100 * 1024
    end,
  },
  indent = { enable = true },
})

-- Flash -----------------------------------------------------------------------
require("flash").setup()

-- Todo-comments ---------------------------------------------------------------
require("todo-comments").setup({ signs = false })

-- Completion ------------------------------------------------------------------
require("blink.cmp").setup({
  appearance = { use_nvim_cmp_as_default = true, nerd_font_variant = "normal" },
  completion = {
    trigger = { show_on_insert_on_trigger_character = true },
    menu = {
      auto_show = true,
      min_width = 25,
      max_height = 15,
      border = "rounded",
      draw = { columns = { { "label", "label_description", gap = 4 }, { "kind_icon", gap = 1, "kind" } } },
    },
    documentation = {
      auto_show = true,
      auto_show_delay_ms = 300,
      window = { border = "rounded" },
    },
  },
  sources    = { default = { "lsp", "path", "snippets", "buffer" } },
  cmdline    = { enabled = true },
  signature  = { enabled = true, window = { border = "rounded" } },
  fuzzy      = { implementation = "lua" },
  keymap     = {
    preset        = "default",
    ["<C-space>"] = { "show", "show_documentation", "hide_documentation" },
    ["<C-e>"]     = { "hide", "fallback" },
    ["<CR>"]      = { "accept", "fallback" },
    ["<Tab>"]     = { "select_and_accept", "snippet_forward", "fallback" },
    ["<S-Tab>"]   = { "select_prev", "snippet_backward", "fallback" },
    ["<Up>"]      = { "select_prev", "fallback" },
    ["<Down>"]    = { "select_next", "fallback" },
    ["<C-k>"]     = { "select_prev", "fallback" },
    ["<C-j>"]     = { "select_next", "fallback" },
    ["<C-b>"]     = { "scroll_documentation_up", "fallback" },
    ["<C-f>"]     = { "scroll_documentation_down", "fallback" },
  },
})

-- Mason -----------------------------------------------------------------------
require("mason").setup()

-- Git -------------------------------------------------------------------------
require("gitsigns").setup({
  signs = {
    add          = { text = "+" },
    change       = { text = "~" },
    delete       = { text = "_" },
    topdelete    = { text = "‾" },
    changedelete = { text = "~" },
  },
})

-- Smart-splits ----------------------------------------------------------------
require("smart-splits").setup()
vim.keymap.set("n", "<C-h>", require("smart-splits").move_cursor_left)
vim.keymap.set("n", "<C-j>", require("smart-splits").move_cursor_down)
vim.keymap.set("n", "<C-k>", require("smart-splits").move_cursor_up)
vim.keymap.set("n", "<C-l>", require("smart-splits").move_cursor_right)

-- Snacks ----------------------------------------------------------------------
require("snacks").setup({
  bigfile   = { enabled = true },
  indent    = { enabled = true },
  quickfile = { enabled = true },
  scroll    = { enabled = true },
  lazygit   = { enabled = true },
  bufdelete = { enabled = true },
  terminal  = { enabled = true },
})

-- ============================================================================
-- [6] LSP
-- ============================================================================

-- Auto-discover lsp/*.lua configs
local lsp_configs = {}
for _, f in pairs(vim.api.nvim_get_runtime_file("lsp/*.lua", true)) do
  table.insert(lsp_configs, vim.fn.fnamemodify(f, ":t:r"))
end
vim.lsp.enable(lsp_configs)

-- Diagnostics
vim.diagnostic.config({
  virtual_text     = { spacing = 4, prefix = "●", source = "if_many" },
  underline        = true,
  update_in_insert = false,
  severity_sort    = true,
  float            = { border = "rounded", source = true },
  signs            = {
    text = {
      [vim.diagnostic.severity.ERROR] = "󰅚 ",
      [vim.diagnostic.severity.WARN]  = "󰀪 ",
      [vim.diagnostic.severity.INFO]  = "󰋽 ",
      [vim.diagnostic.severity.HINT]  = "󰌶 ",
    },
    numhl = {
      [vim.diagnostic.severity.ERROR] = "ErrorMsg",
      [vim.diagnostic.severity.WARN]  = "WarningMsg",
    },
  },
})

-- LSP keymaps on attach
vim.api.nvim_create_autocmd("LspAttach", {
  group = vim.api.nvim_create_augroup("lsp-attach", { clear = true }),
  callback = function(event)
    local map = function(keys, func, desc)
      vim.keymap.set("n", keys, func, { buffer = event.buf, desc = "LSP: " .. desc })
    end
    map("gl", vim.diagnostic.open_float, "Diagnostic float")
    map("K", vim.lsp.buf.hover, "Hover docs")
    map("gs", vim.lsp.buf.signature_help, "Signature help")
    map("gD", vim.lsp.buf.declaration, "Go to declaration")
    map("gd", vim.lsp.buf.definition, "Go to definition")
    map("<leader>la", vim.lsp.buf.code_action, "Code action")
    map("<leader>lr", vim.lsp.buf.rename, "Rename")
    map("<leader>lf", vim.lsp.buf.format, "Format")
    map("<leader>f", vim.lsp.buf.format, "Format buffer")
    map("<leader>v", "<cmd>vsplit | lua vim.lsp.buf.definition()<cr>", "Definition in vsplit")
  end,
})
