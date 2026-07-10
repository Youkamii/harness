#!/usr/bin/env bash
# 결정적 채점: fizzbuzz.py 의 실제 출력만 본다.
set -euo pipefail
[ -f fizzbuzz.py ] || { echo "fizzbuzz.py 없음"; exit 1; }
out=$(python3 fizzbuzz.py 15)
[ "$(echo "$out" | sed -n '1p')" = "1" ] || { echo "1행이 '1'이 아님"; exit 1; }
[ "$(echo "$out" | sed -n '3p')" = "Fizz" ] || { echo "3행이 'Fizz'가 아님"; exit 1; }
[ "$(echo "$out" | sed -n '5p')" = "Buzz" ] || { echo "5행이 'Buzz'가 아님"; exit 1; }
[ "$(echo "$out" | sed -n '15p')" = "FizzBuzz" ] || { echo "15행이 'FizzBuzz'가 아님"; exit 1; }
[ "$(echo "$out" | wc -l | tr -d ' ')" = "15" ] || { echo "출력이 15행이 아님"; exit 1; }
echo OK
