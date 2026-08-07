@echo off
REM 一键运行 ASIN 站外推广侦察（一体化 CLI）
REM 用法: scan.bat B0H6Q7VFK9 [--brand=Boytond] [--product="AI Translation Earbuds"] ...
node "%~dp0scan.js" %*
