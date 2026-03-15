-- Mineo bundled Neovim config
-- This is the default config shipped with Mineo.
-- Edit this file to customise the bundled experience,
-- or switch to "System config" / "Custom folder" in Settings (⌘,).

vim.opt.number         = true
vim.opt.relativenumber = false
vim.opt.mouse          = 'a'
vim.opt.termguicolors  = true
vim.opt.signcolumn     = 'yes'
vim.opt.cursorline     = true
vim.opt.scrolloff      = 8
vim.opt.tabstop        = 2
vim.opt.shiftwidth     = 2
vim.opt.expandtab      = true
vim.opt.smartindent    = true
vim.opt.wrap           = false
vim.opt.hlsearch       = false
vim.opt.incsearch      = true
vim.opt.ignorecase     = true
vim.opt.smartcase      = true
vim.opt.updatetime     = 250
vim.opt.clipboard      = 'unnamedplus'

-- Ensure the cursor is always visible inside xterm.js (web terminal).
-- Without an explicit guicursor Neovim may emit no cursor-shape escape
-- codes, leaving the block cursor invisible when termguicolors is on.
vim.opt.guicursor = 'n-v-c-sm:block,i-ci-ve:ver25,r-cr-o:hor20'
