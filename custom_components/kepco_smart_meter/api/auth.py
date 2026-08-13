"""파워플래너 로그인 (설계문서 §7, §19).

브라우저가 하는 일을 그대로 재현한다.

  1. GET /               → 쿠키 cookieRsa(공개키 모듈러스), cookieSsId(세션)
  2. 아이디/비밀번호를 RSA(PKCS#1 v1.5)로 암호화하고 앞에 세션ID를 붙인다
  3. POST /intro/chkUser.do → SSO 구분값 (자격증명 검증도 여기서 이뤄진다)
  4. POST /login            → 세션 확립

두 가지가 함정이었다.

* **TLS 지문**: 앞단이 평범한 파이썬 HTTP 클라이언트를 조용히 거부한다. RSA·헤더·
  페이로드가 전부 맞아도 자격증명 오류만 돌아온다. 그래서 브라우저 TLS 지문을
  흉내내는 curl_cffi 를 쓴다. 이것이 Selenium 없이 갈 수 있는 이유다(§8).
* **쿠키 인코딩**: 서버는 cookieSsId 를 URL 인코딩해 내려준다(`...ZDEvdzI%3D`).
  페이지의 getCookie() 가 decodeURIComponent 를 거치므로 반드시 디코딩해야 한다.
  두 글자가 어긋나면 서버가 자격증명을 해석하지 못한다.
"""
from __future__ import annotations

import json
import logging
import secrets
from urllib.parse import unquote

from curl_cffi import AsyncSession

from .exceptions import (
    KepcoAuthError,
    KepcoEndpointUnavailable,
    KepcoResponseFormatError,
)

_LOGGER = logging.getLogger(__name__)

BASE = "https://pp.kepco.co.kr"
IMPERSONATE = "chrome"
RSA_EXPONENT = "10001"  # 65537


def pkcs1_v15_encrypt_hex(modulus_hex: str, exponent_hex: str, text: str) -> str:
    """jsbn(RSAKey.encrypt) 과 동일한 결과를 내는 RSA 암호화.

    표준 라이브러리만으로 충분하다. RSA 공개키 연산은 패딩과 모듈러 거듭제곱뿐이다.
    jsbn 은 결과를 16진 문자열로 주되 길이가 홀수일 때만 앞에 0 을 붙인다.
    모듈러스 길이까지 0 을 채우지는 않으므로 그 동작을 그대로 맞춘다.
    """
    n = int(modulus_hex, 16)
    e = int(exponent_hex, 16)
    k = (n.bit_length() + 7) // 8

    msg = text.encode("utf-8")
    if len(msg) > k - 11:
        raise KepcoResponseFormatError("입력이 RSA 키 길이를 초과함")

    # EM = 0x00 || 0x02 || PS(0이 아닌 난수) || 0x00 || M
    ps = bytearray()
    while len(ps) < k - len(msg) - 3:
        b = secrets.token_bytes(1)
        if b != b"\x00":
            ps += b
    em = b"\x00\x02" + bytes(ps) + b"\x00" + msg

    c = pow(int.from_bytes(em, "big"), e, n)
    h = format(c, "x")
    return h if len(h) % 2 == 0 else "0" + h


async def async_login(session: AsyncSession, user_id: str, password: str) -> None:
    """세션에 인증 쿠키를 심는다. 실패하면 예외를 던진다."""
    resp = await session.get(BASE + "/")
    if resp.status_code != 200:
        raise KepcoEndpointUnavailable(f"로그인 페이지 응답 {resp.status_code}")

    cookies = {k: unquote(v) for k, v in resp.cookies.items()}
    modulus = cookies.get("cookieRsa")
    sess_id = cookies.get("cookieSsId")
    if not modulus or not sess_id:
        raise KepcoResponseFormatError("RSA 공개키 또는 세션 쿠키를 받지 못함")

    enc_id = pkcs1_v15_encrypt_hex(modulus, RSA_EXPONENT, user_id)
    enc_pw = pkcs1_v15_encrypt_hex(modulus, RSA_EXPONENT, password)
    sso_id = f"{sess_id}_{enc_id}"
    sso_pw = f"{sess_id}_{enc_pw}"

    resp = await session.post(
        BASE + "/intro/chkUser.do",
        json={"USER_ID": sso_id, "USER_PWD": sso_pw, "USER_CI": "", "TYPE": "I"},
        headers={"X-Requested-With": "XMLHttpRequest", "Referer": BASE + "/"},
    )
    try:
        chk = json.loads(resp.text)
    except ValueError as err:
        raise KepcoResponseFormatError(f"chkUser 응답 해석 실패: {err}") from err

    result = chk.get("result", "") if isinstance(chk, dict) else ""
    # 'success' = 통합아이디, 'addCustno' = 고객번호 추가 필요, 그 외 = 기존아이디 경로
    if result == "success":
        sso_flag = chk.get("USER_SSO_YN", "Y")
    elif result == "addCustno":
        sso_flag = ""
    else:
        sso_flag = "N"

    resp = await session.post(
        BASE + "/login",
        data={
            "USER_ID": sso_id,
            "USER_PWD": sso_pw,
            # 아이디가 10자를 넘으면 아파트 세대 고객으로 취급한다(사이트 로직).
            "APT_YN": "Y" if len(user_id) > 10 else "N",
            "SSO_ID": sso_flag,
        },
        headers={"Referer": BASE + "/"},
    )

    # 실패하면 /intro.do 로 되돌아온다. 성공하면 스마트뷰(/rm/...) 로 간다.
    if "/intro.do" in str(resp.url) or "RSA_USER_PWD" in resp.text:
        raise KepcoAuthError("아이디 또는 비밀번호가 올바르지 않습니다")

    _LOGGER.debug("파워플래너 로그인 성공 (%s)", resp.url)
