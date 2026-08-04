# Bug：writer lock rename 覆盖空锁目录

## 现象
预置空 `.writer.lock` 目录时，竞争 writer 可在数毫秒内取得锁。

## 影响
未知 owner 被覆盖，破坏 fail-closed 互斥保证。

## 根因
POSIX `rename` 可以替换空目标目录，候选目录发布不是 no-clobber。

## 修复
候选完整 owner 改为 0600 regular file，并以 `linkSync` 原子发布；`link` 遇任何既有目录或文件均为 EEXIST。

## 验证
测试确认空目录等待至有界 timeout，目录及其空 identity 不变；新锁为完整 regular file。

## 预防
发布路径只能使用内核 no-clobber 原语，不得以 exists-check 加 rename 替代。
