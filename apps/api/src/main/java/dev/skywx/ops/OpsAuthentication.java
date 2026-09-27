package dev.skywx.ops;

import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;

import java.util.Collection;

/** 세션에 저장되는 인증 객체(비밀번호는 담지 않는다). */
public class OpsAuthentication extends AbstractAuthenticationToken {
    private final OpsUserService.User user;

    public OpsAuthentication(OpsUserService.User user, Collection<? extends GrantedAuthority> authorities) {
        super(authorities);
        this.user = user;
        setAuthenticated(true);
    }

    public OpsUserService.User user() { return user; }
    @Override public Object getCredentials() { return ""; }
    @Override public Object getPrincipal() { return user.username(); }
    @Override public String getName() { return user.username(); }
}
